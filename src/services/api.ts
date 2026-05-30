// Cliente HTTP del POS Cajero. Habla con el mismo backend que el panel admin
// de Tiendademo (Nest, expuesto en /api). El cajero hereda 1:1 los endpoints
// públicos de productos, ventas, caja, settings y app-config.
//
// Auth: lee el JWT que guarda Login.tsx en `pos_web_session_v1` y lo manda
// como `Authorization: Bearer <jwt>`. Los controladores actuales del backend
// no exigen guard, pero adjuntamos el token para futuras restricciones y para
// trazar quién emite cada venta.

const BASE = (import.meta.env.VITE_API_URL || '') + '/api';

// ── Auth header — JWT del cajero (lib/storage.ts) ────────────────────────────

interface StoredSession {
  jwt: string;
  expiresAt: number;
  cash?: { displayCode?: string; deviceName?: string };
}

function readToken(): string | null {
  try {
    const raw = localStorage.getItem('pos_web_session_v1');
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    return s?.jwt || null;
  } catch { return null; }
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let body: any = null;
  if (text.trim()) {
    try { body = JSON.parse(text); }
    catch { throw new Error(`Respuesta inválida del servidor (status ${res.status})`); }
  }
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('pos:session-expired'));
    }
    const err: Error & { code?: string; status?: number } = new Error(body?.message || res.statusText || 'Request failed');
    if (body?.code) err.code = String(body.code);
    err.status = res.status;
    throw err;
  }
  // Soft-auth: backend responde 200 con `{ sessionExpired: true }` en /pos/me
  // cuando el JWT está stale — mismo efecto que 401 pero sin error rojo en consola.
  if (body && typeof body === 'object' && body.sessionExpired === true) {
    window.dispatchEvent(new CustomEvent('pos:session-expired'));
    const err: Error & { code?: string; status?: number } = new Error(body.message || 'Sesión expirada');
    err.code = 'session-expired';
    err.status = 401;
    throw err;
  }
  return body as T;
}

// ── Domain types — espejo del admin (services/api.ts en Tiendademo) ─────────

export type ProductStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface WholesaleTier {
  min_qty: number;
  price: number;
}

export interface Product {
  id: string;
  name: string;
  barcode: string | null;
  price: number;
  cost: number;
  stock: number;
  category: string | null;
  unit_type: 'unit' | 'kg';
  description?: string | null;
  attributes?: Record<string, string | number | boolean>;
  is_wholesale?: boolean;
  wholesale_tiers?: WholesaleTier[];
  is_digital?: boolean;
  is_perishable?: boolean;
  status?: ProductStatus;
  publish_at?: string | null;
}

export interface BillBreakdown {
  denom: number;
  qty: number;
}

export interface SalePayment {
  id?: string;
  method: string;
  amount: number;
  billsPaid?: BillBreakdown[] | null;
  changeGiven?: number;
  reference?: string | null;
}

export interface SaleItem {
  id: string;
  productId: string;
  productName: string;
  qty: number;
  unitType: 'unit' | 'kg';
  price: number;
  subtotal: number;
  returnedQty?: number;
}

export type EInvoiceStatus = 'not_requested' | 'pending' | 'emitted' | 'failed' | 'cancelled';

export interface Sale {
  id: string;
  total: number;
  paymentType: string;
  status: string;
  notes: string | null;
  items: SaleItem[];
  payments?: SalePayment[];
  createdAt: string;
  einvoiceStatus?: EInvoiceStatus | null;
  einvoiceCufe?: string | null;
  einvoiceNumber?: string | null;
}

export type PaymentMethodType = 'cash' | 'transfer' | 'nequi' | 'llave' | 'fiado';

export interface PaymentMethodDetails {
  bank?: string;
  account_number?: string;
  account_type?: 'ahorros' | 'corriente' | 'nequi' | 'daviplata';
  holder_name?: string;
  holder_id?: string;
  phone?: string;
  platform?: string;
  notes?: string;
}

export interface PaymentMethod {
  id: string;
  name: string;
  type: PaymentMethodType;
  icon: string;
  active: boolean;
  start_hour: number | null;
  end_hour: number | null;
  sort_order: number;
  details: PaymentMethodDetails | null;
  description: string | null;
}

export interface CashSession {
  id: string;
  opened_at: string;
  opened_by: string;
  opening_amount: number;
  closed_at: string | null;
  closed_by: string | null;
  expected_amount: number | null;
  counted_amount: number | null;
  difference: number | null;
  status: 'open' | 'closed';
  notes: string | null;
}

export type CashMovementType =
  | 'sale' | 'expense' | 'salary' | 'inventory_purchase'
  | 'withdrawal' | 'deposit' | 'adjustment';

export interface CashMovement {
  id: string;
  session_id: string;
  type: CashMovementType;
  amount: number;
  reason: string;
  authorized_by: string | null;
  created_by: string;
  sale_id: string | null;
  created_at: string;
}

// ── Cashier bootstrap — /api/pos/me retorna catálogo + métodos de pago +
//    features del negocio + datos de la caja en una sola llamada. Es el
//    endpoint que el JWT de dispositivo SÍ puede consumir (los endpoints
//    /api/products, /api/sales, /api/settings/* exigen JWT de usuario admin).

export interface MeResponse {
  cash: {
    id:           string;
    displayCode:  string;
    deviceName:   string;
    label:        string | null;
    color:        string | null;
    cashierId:    string | null;
    locationId:   string | null;
  };
  store: { id: string; name: string; phone: string; type: string; offering: string };
  features: { fiadoEnabled: boolean; sellByWeight: boolean; sellDigital: boolean; wholesale: boolean; canConfirmTransfers: boolean };
  paymentMethods: PaymentMethod[];
  products:       Product[];
  serverTime:     string;
}

// ── Tipos adicionales para Caja, Fiados, Ventas, Clientes ────────────────────

export interface FiadoClient {
  id: string;
  client_name: string;
  client_phone: string | null;
  total_owed: number;
  last_activity: string;
  status: 'pending' | 'partial' | 'settled';
  days_overdue: number;
  risk_level: 'high' | 'mid' | 'low';
  notes: string | null;
}

export interface FiadoPayment {
  id: string;
  amount: number;
  payment_method: string;
  paid_at: string;
  notes: string | null;
}

export interface Customer {
  id: string;
  name: string;
  document_id: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  total_spent: number;
  last_purchase_at: string | null;
}

// ── API surface ───────────────────────────────────────────────────────────────

export const api = {
  pos: {
    me: () => req<MeResponse>('/pos/me'),
    paymentMethods: () => req<PaymentMethod[]>('/pos/payment-methods'),
    sale: (
      items: Array<{ productId: string; qty: number }>,
      paymentType = 'Efectivo',
      notes?: string,
      payments?: SalePayment[],
      cashierId?: string | null,
    ) =>
      req<{ id: string; total: number; items: number }>('/pos/sale', {
        method: 'POST',
        body: JSON.stringify({ items, paymentType, notes, payments, cashierId }),
      }),
  },

  cash: {
    current: () => req<{ session: CashSession | null; movements: CashMovement[] }>('/pos/cash'),
    open: (openingAmount: number, notes?: string) =>
      req<CashSession>('/pos/cash/open', {
        method: 'POST',
        body: JSON.stringify({ openingAmount, notes }),
      }),
    close: (countedAmount: number, notes?: string) =>
      req<CashSession>('/pos/cash/close', {
        method: 'POST',
        body: JSON.stringify({ countedAmount, notes }),
      }),
    addMovement: (type: CashMovementType, amount: number, reason: string) =>
      req<CashMovement>('/pos/cash/movement', {
        method: 'POST',
        body: JSON.stringify({ type, amount, reason }),
      }),
  },

  fiados: {
    list: () => req<{ clients: FiadoClient[]; stats: Record<string, number> }>('/pos/fiados'),
    abonar: (fiadoId: string, amount: number, method: string, notes?: string) =>
      req<{ success: boolean }>(`/pos/fiados/${fiadoId}/pay`, {
        method: 'POST',
        body: JSON.stringify({ amount, paymentMethod: method, notes }),
      }),
    settle: (fiadoId: string, method: string) =>
      req<{ success: boolean }>(`/pos/fiados/${fiadoId}/settle`, {
        method: 'POST',
        body: JSON.stringify({ paymentMethod: method }),
      }),
  },

  sales: {
    list: (params?: { limit?: number; offset?: number; start?: string; end?: string; search?: string; cashierId?: string; paymentType?: string }) => {
      const p = new URLSearchParams();
      if (params?.limit)       p.set('limit',        String(params.limit));
      if (params?.offset)      p.set('offset',       String(params.offset));
      if (params?.cashierId)   p.set('cashier_id',   params.cashierId);
      if (params?.search)      p.set('search',       params.search);
      if (params?.start)       p.set('start',        params.start);
      if (params?.end)         p.set('end',          params.end);
      if (params?.paymentType) p.set('payment_type', params.paymentType);
      return req<{ items: Sale[]; total: number }>(`/pos/sales?${p}`);
    },
    processReturn: (
      saleId: string,
      payload: {
        reason: string;
        refundMethod: string;
        items: Array<{ saleItemId: string; qty: number; refundAmount: number; restock: boolean }>;
        notes?: string;
        partial: boolean;
      },
    ) =>
      req<{ id: string; total_refunded: number; items: number; partial: boolean }>(
        `/pos/sales/${saleId}/return`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
  },

  customers: {
    list: (search?: string) =>
      req<Customer[]>(search ? `/pos/customers?search=${encodeURIComponent(search)}` : '/pos/customers'),
    create: (data: { name: string; documentId?: string; whatsapp?: string; email?: string; address?: string; notes?: string }) =>
      req<Customer>('/pos/customers', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<{ name: string; documentId: string; whatsapp: string; email: string; address: string; notes: string }>) =>
      req<Customer>(`/pos/customers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },

  appConfig: {
    get: (key: string) => req<{ value: string | null }>(`/app-config/${encodeURIComponent(key)}`),
    set: (key: string, value: any) =>
      req<{ success: boolean }>(`/app-config/${encodeURIComponent(key)}`, {
        method: 'POST',
        body: JSON.stringify({ value }),
      }),
  },
};
