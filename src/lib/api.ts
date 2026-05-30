// Tiny fetch wrapper for the Web POS. Talks to the Express backend.
// Reads VITE_API_URL at build time; falls back to localhost:3000 in dev.

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:3000') + '/api';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOpts extends Omit<RequestInit, 'body'> {
  jwt?: string | null;
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (opts.jwt) headers['Authorization'] = `Bearer ${opts.jwt}`;

  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let body: any = null;
  if (text.trim()) {
    try { body = JSON.parse(text); }
    catch { throw new ApiError(`Respuesta inválida del servidor (status ${res.status})`, res.status); }
  }
  if (!res.ok) {
    if (res.status === 401 && opts.jwt) window.dispatchEvent(new CustomEvent('pos:session-expired'));
    throw new ApiError(body?.message || `HTTP ${res.status}`, res.status);
  }
  // Soft-auth: el backend responde 200 con `{ sessionExpired: true }` en /pos/me
  // cuando el JWT está stale, para no ensuciar consola con 401. Lo tratamos
  // exactamente igual que un 401 (limpia sesión y manda a login) pero sin
  // lanzar excepción que pinte en rojo.
  if (body && typeof body === 'object' && (body as any).sessionExpired === true) {
    if (opts.jwt) window.dispatchEvent(new CustomEvent('pos:session-expired'));
    throw new ApiError((body as any).message || 'Sesión expirada', 401, 'session-expired');
  }
  return body as T;
}

// ─── Domain types (1:1 with frontend admin) ─────────────────────────────────

export type ProductStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface WholesaleTier {
  min_qty: number;
  price:   number;
}

export interface Product {
  id:               string;
  name:             string;
  barcode:          string | null;
  price:            number;
  cost:             number;
  stock:            number;
  category:         string | null;
  unit_type:        'unit' | 'kg';
  description?:     string | null;
  attributes?:      Record<string, string | number | boolean>;
  is_wholesale?:    boolean;
  wholesale_tiers?: WholesaleTier[];
  is_digital?:      boolean;
  status?:          ProductStatus;
  publish_at?:      string | null;
}

export interface BillBreakdown { denom: number; qty: number }

export interface SalePayment {
  id?:           string;
  method:        string;
  amount:        number;
  billsPaid?:    BillBreakdown[] | null;
  changeGiven?:  number;
  reference?:    string | null;
}

export type PaymentMethodType = 'cash' | 'nequi' | 'llave' | 'fiado';

export interface PaymentMethodDetails {
  bank?:           string;
  account_number?: string;
  account_type?:   'ahorros' | 'corriente';
  holder_name?:    string;
  holder_id?:      string;
  phone?:          string;
  platform?:       string;
  notes?:          string;
}

export interface PaymentMethod {
  id:           string;
  name:         string;
  type:         PaymentMethodType;
  icon:         string;
  active:       boolean;
  start_hour:   number | null;
  end_hour:     number | null;
  sort_order:   number;
  details:      PaymentMethodDetails | null;
  description:  string | null;
}

export interface CashSummary {
  id:           string;
  displayCode:  string;
  deviceName:   string;
  cashierId:    string | null;
  locationId:   string | null;
  label:        string | null;
  color:        string | null;
}

export interface LoginResponse {
  success:    true;
  jwt:        string;
  expiresInS: number;
  cash:       CashSummary;
}

export interface MeResponse {
  cash:           CashSummary;
  store:          { id: string; name: string; phone: string; type: string; offering: string };
  features:       { fiadoEnabled: boolean; sellByWeight: boolean; sellDigital: boolean; wholesale: boolean };
  paymentMethods: PaymentMethod[];
  products:       Product[];
  serverTime:     string;
}

export interface PendingCommand {
  id:           string;
  token_id:     string;
  command:      string;
  payload:      Record<string, unknown>;
  status:       string;
  issued_by:    string | null;
  issued_at:    string;
  expires_at:   string;
}

// ─── API surface ────────────────────────────────────────────────────────────

export const api = {
  // El backend devuelve 200 con `{ pinRequired: true }` cuando la caja tiene
  // PIN configurado y todavía no se envió. Lo convertimos en un ApiError con
  // code='pin-required' para que la UI muestre el campo sin pintar 4xx en
  // consola. (Compat: backends antiguos devolvían 400 con "PIN" en mensaje.)
  login: async (code: string, pin: string, deviceName?: string) => {
    const r = await request<LoginResponse & { pinRequired?: boolean }>(
      '/pos/login',
      { method: 'POST', body: { code, pin, deviceName } },
    );
    if (r && (r as any).pinRequired) {
      throw new ApiError((r as any).message || 'PIN requerido', 200, 'pin-required');
    }
    return r as LoginResponse;
  },

  me: (jwt: string) =>
    request<MeResponse>('/pos/me', { method: 'GET', jwt }),

  heartbeat: (jwt: string) =>
    request<{ ok: true; ts: string }>('/pos/heartbeat', { method: 'POST', jwt }),

  pendingCommands: (jwt: string) =>
    request<PendingCommand[]>('/pos/pending-commands', { method: 'GET', jwt }),

  ackCommand: (jwt: string, id: string, result: 'ok' | 'error', errorMsg?: string) =>
    request<{ ok: true }>(`/pos/commands/${id}/ack`, {
      method: 'POST', jwt,
      body:   { result, errorMsg },
    }),

  // Single-sale online checkout. Mirrors admin POS /api/sales semantics:
  //   items + paymentType (or payments[]) + notes → completed sale
  sale: (
    jwt: string,
    items: { productId: string; qty: number }[],
    paymentType: string,
    notes?: string,
    payments?: SalePayment[],
  ) =>
    request<{ id: string; total: number; items: number }>('/pos/sale', {
      method: 'POST', jwt,
      body:   { items, paymentType, notes, payments },
    }),
};
