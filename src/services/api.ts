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

// ── Empleado activo — caja compartida ────────────────────────────────────────
// La caja (token) la usan varios empleados. El empleado seleccionado se guarda
// en sessionStorage (sobrevive recargas, NO el cierre de pestaña → al reabrir
// se vuelve a pedir el PIN). Su id viaja en `X-Pos-Cashier-Id` para atribuir
// cada venta/movimiento al empleado correcto en el backend.

export interface ActiveCashier { id: string; name: string; role: string }

const ACTIVE_CASHIER_KEY = 'pos_active_cashier';

let activeCashier: ActiveCashier | null = (() => {
  try {
    const r = sessionStorage.getItem(ACTIVE_CASHIER_KEY);
    return r ? (JSON.parse(r) as ActiveCashier) : null;
  } catch { return null; }
})();

export function getActiveCashier(): ActiveCashier | null { return activeCashier; }

export function setActiveCashier(c: ActiveCashier | null): void {
  activeCashier = c;
  try {
    if (c) sessionStorage.setItem(ACTIVE_CASHIER_KEY, JSON.stringify(c));
    else sessionStorage.removeItem(ACTIVE_CASHIER_KEY);
  } catch { /* sin sessionStorage en algunos entornos */ }
}

// Epoch de sesión de la caja. /pos/me lo devuelve; lo reenviamos en cada
// request. Si el admin "cierra la sesión", el server sube su epoch → al mandar
// el viejo, /pos/me responde `cashierLocked: true` (lo maneja Pos.tsx).
let knownEpoch: number | null = null;

// El login (lib/api.ts, otro módulo) sube el epoch en el server pero no toca
// este valor en memoria. Sin sembrarlo, tras re-loguear seguimos mandando el
// epoch viejo y el server responde 401 session_revoked en la primera llamada
// (p. ej. /pos/cashiers) → rebote al login. Por eso App.tsx siembra el epoch
// devuelto por el login y lo resetea al cerrar sesión.
export function setSessionEpoch(epoch: number | null): void {
  knownEpoch = epoch;
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(activeCashier ? { 'X-Pos-Cashier-Id': activeCashier.id } : {}),
    ...(knownEpoch != null ? { 'X-Pos-Session-Epoch': String(knownEpoch) } : {}),
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
    const err: Error & { code?: string; status?: number } = new Error(body?.message || body?.error || res.statusText || 'Request failed');
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
  // /pos/me trae el epoch actual de la caja → lo recordamos para reenviarlo.
  if (body && typeof body === 'object' && typeof body.sessionEpoch === 'number') {
    knownEpoch = body.sessionEpoch;
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

export type PaymentMethodType = 'cash' | 'transfer' | 'nequi' | 'llave' | 'credito';

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
  // Carry-over (arqueo): expected at open = last close counted; difference +
  // explanation captured when the open count doesn't match.
  opening_expected?: number | null;
  opening_difference?: number | null;
  opening_explanation?: string | null;
}

export type CashMovementType =
  | 'sale' | 'expense' | 'salary' | 'inventory_purchase'
  | 'withdrawal' | 'deposit' | 'adjustment' | 'advance'
  | 'credito_payment' | 'reclassification';

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

export type CashierRole = 'admin' | 'cashier' | 'employee';

export interface CashierLite {
  id:     string;
  name:   string;
  role:   CashierRole;
  hasPin: boolean;
}

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
  store: { id: string; name: string; phone: string; type: string; offering: string; creditoTermDays?: number };
  features: { creditoEnabled: boolean; sellByWeight: boolean; sellDigital: boolean; wholesale: boolean; canConfirmTransfers: boolean; allowOversell?: boolean; einvoiceEnabled?: boolean };
  paymentMethods: PaymentMethod[];
  cashiers:       CashierLite[];
  products:       Product[];
  sessionEpoch?:  number;
  cashierLocked?: boolean;
  serverTime:     string;
}

// ── Tipos adicionales para Caja, Creditos, Ventas, Clientes ────────────────────

export interface CreditoClient {
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

export interface CreditoPayment {
  id: string;
  amount: number;
  payment_method: string;
  paid_at: string;
  notes: string | null;
}

// Settled-credito row for the history tab. Org-wide: a debt saldada at any
// register/sede shows here. Wire shape produced by the backend
// (getCreditosHistoryForPos) — snake_case on purpose.
export interface CreditoHistoryItem {
  id: string;
  client_name: string;
  client_phone: string | null;
  total: number;
  created_at: string;
  settled_at: string;
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

// ── Customer detail (ficha de cliente) ───────────────────────────────────────
// Shape returned by GET /pos/customers/{id}/detail — the SAME contract the
// dashboard renders. Dates arrive as ISO strings (JSON), numeric money columns
// (totalSpent/total) as strings; counters/amounts already parsed to numbers.

export interface CustomerDetailSale {
  id: string;
  saleNumber: number | null;
  date: string;
  total: string;
  paymentType: string;
  status: string;
  fullyReturned: boolean;
}

export interface CustomerDetailAbono {
  id: string;
  date: string;
  amount: number;
  method: string | null;
}

export interface CustomerDetailDelivery {
  id: string;
  date: string;
  total: string;
  status: string;
}

export interface CustomerDetail {
  profile: {
    id: string;
    name: string;
    documentId: string | null;
    whatsapp: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    totalSpent: string;
    lastPurchaseAt: string | null;
    createdAt: string;
  };
  kpis: {
    totalSpent: string;
    purchaseCount: number;
    avgTicket: number;
    lastPurchaseAt: string | null;
    creditBalance: number;
  };
  recentSales: CustomerDetailSale[];
  credito: { balance: number; recentAbonos: CustomerDetailAbono[] };
  deliveries: CustomerDetailDelivery[];
}

export interface SupplierLite {
  id: string;
  name: string;
  company: string | null;
}

export interface SupplierOutstandingInvoice {
  payableId: string;
  invoiceNumber: string | null;
  outstanding: string;
  status: 'open' | 'partial';
}

export interface SupplierOutstanding {
  supplierId: string;
  totalOutstanding: string;
  invoiceCount: number;
  invoices: SupplierOutstandingInvoice[];
}

export interface MovementOutcome {
  outcome?: 'settled' | 'gasto';
  appliedTotal?: string;
  settledPayables?: number;
}

// ── API surface ───────────────────────────────────────────────────────────────

export const api = {
  cashiers: {
    list: () => req<{ cashiers: CashierLite[] }>('/pos/cashiers'),
    verifyPin: (cashierId: string, pin: string) =>
      req<{ ok: boolean; cashier: CashierLite }>('/pos/cashiers/verify-pin', {
        method: 'POST',
        body: JSON.stringify({ cashierId, pin }),
      }),
    setPin: (cashierId: string, currentPin: string, newPin: string) =>
      req<{ ok: boolean; hasPin: boolean }>('/pos/cashiers/set-pin', {
        method: 'POST',
        body: JSON.stringify({ cashierId, currentPin, newPin }),
      }),
    // Public — sets a cashier's OWN PIN via the one-time activation link the admin
    // sent over WhatsApp. No device token/session needed (the link IS the auth),
    // so it works on the standalone /activar screen before any POS login.
    activate: (token: string, pin: string) =>
      req<{ ok: boolean; name: string }>('/pos/cashiers/activate', {
        method: 'POST',
        body: JSON.stringify({ token, pin }),
      }),
  },

  pos: {
    me: () => req<MeResponse>('/pos/me'),
    paymentMethods: () => req<PaymentMethod[]>('/pos/payment-methods'),
    sale: (
      items: Array<{ productId: string; qty: number }>,
      paymentType = 'Efectivo',
      notes?: string,
      payments?: SalePayment[],
      cashierId?: string | null,
      // Exactly-once key: the server dedupes by sale_idempotency_key, so a retry
      // (e.g. a dropped response, or a queued sale drained twice) never creates a
      // second sale. Omitted for legacy callers → server treats it as no-dedupe.
      saleIdempotencyKey?: string | null,
      // Manual credit due date ('YYYY-MM-DD'). The server stores it verbatim and
      // only falls back to the org default term when omitted.
      dueDate?: string | null,
    ) =>
      req<{ id: string; total: number; items: number }>('/pos/sale', {
        method: 'POST',
        body: JSON.stringify({
          items,
          paymentType,
          notes,
          payments,
          cashierId,
          sale_idempotency_key: saleIdempotencyKey ?? undefined,
          dueDate: dueDate ?? undefined,
        }),
      }),
  },

  cash: {
    current: () =>
      req<{ session: CashSession | null; movements: CashMovement[]; expected: number; expected_opening?: number }>(
        '/pos/cash/current',
      ),
    open: (openingAmount: number, notes?: string, explanation?: string) =>
      req<CashSession>('/pos/cash/open', {
        method: 'POST',
        body: JSON.stringify({ openingAmount, notes, explanation }),
      }),
    close: (countedAmount: number, notes?: string) =>
      req<CashSession>('/pos/cash/close', {
        method: 'POST',
        body: JSON.stringify({ countedAmount, notes }),
      }),
    addMovement: (type: CashMovementType, amount: number, reason: string, supplierId?: string | null) =>
      req<CashMovement & MovementOutcome>('/pos/cash/movement', {
        method: 'POST',
        body: JSON.stringify({ type, amount, reason, supplierId: supplierId ?? null }),
      }),
  },

  suppliers: {
    // Active suppliers of the caja's org, for the "Pago a proveedor" select.
    list: () => req<{ suppliers: SupplierLite[] }>('/pos/suppliers'),
    // Outstanding invoices for a specific supplier. Used to surface the debt
    // summary before registering a "Pago a proveedor" movement.
    outstanding: (id: string) => req<SupplierOutstanding>(`/pos/suppliers/${id}/outstanding`),
  },

  creditos: {
    list: () => req<{ clients: CreditoClient[]; stats: Record<string, number> }>('/pos/creditos'),
    // `clientKey` is CreditoClient.id from /pos/creditos: the server groups a client's
    // debts under one key and distributes the abono FIFO (oldest due first). The
    // endpoints are action-style (/abonar, /settle) and expect { clientKey, method },
    // NOT the old Tiendademo REST shape (/creditos/{id}/pay, { paymentMethod }).
    abonar: (clientKey: string, amount: number, method: string, notes?: string) =>
      req<{ applied: number; remaining: number; settledSaleIds: string[]; hitCaja: boolean }>('/pos/creditos/abonar', {
        method: 'POST',
        body: JSON.stringify({ clientKey, amount, method, notes }),
      }),
    settle: (clientKey: string, method: string) =>
      req<{ settledSaleIds: string[]; settled: number; totalPaid: number }>('/pos/creditos/settle', {
        method: 'POST',
        body: JSON.stringify({ clientKey, method }),
      }),
    // Org-wide settled-credito history. Goes through req() so it hits the backend
    // origin (BASE) with auth — a raw relative fetch would hit the device's own
    // host and silently return nothing.
    history: () => req<CreditoHistoryItem[]>('/pos/creditos/history'),
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
        // Only for reason 'damaged': 'replace' = exchange (no money back),
        // 'refund' = money back in cash. Ignored for other reasons.
        damagedResolution?: 'replace' | 'refund';
        items: Array<{ saleItemId: string; qty: number; refundAmount: number; restock: boolean }>;
        notes?: string;
        partial: boolean;
      },
    ) =>
      req<{ id: string; total_refunded: number; items: number; partial: boolean }>(
        `/pos/sales/${saleId}/return`,
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    // "Error de carga": move an amount of a sale's payment from one method to
    // another (e.g. a mixed cash/transfer split entered wrong). Only valid for a
    // sale of the current shift — the backend rejects anything older.
    reclassify: (salePaymentId: string, toMethod: string, amount: number) =>
      req<{ ok: boolean }>('/pos/sales/reclassify', {
        method: 'POST',
        body: JSON.stringify({
          sale_payment_id: salePaymentId,
          to_method: toMethod,
          amount,
        }),
      }),
    // Re-enter the WHOLE payment split for a sale using the POS checkout (e.g. a
    // sale charged as full cash was really cash + transfer). The total stays the
    // same — only the method breakdown changes. Only valid for a sale of the
    // current shift; the backend rejects anything older.
    resplit: (saleId: string, payments: SalePayment[], notes?: string, dueDate?: string | null) =>
      req<{ ok: boolean }>('/pos/sales/resplit', {
        method: 'POST',
        body: JSON.stringify({
          sale_id: saleId,
          payments: payments.map(p => ({
            method: p.method,
            amount: p.amount,
            reference: p.reference ?? null,
            change_given: p.changeGiven ?? 0,
          })),
          notes: notes ?? null,
          due_date: dueDate ?? null,
        }),
      }),
  },

  customers: {
    // GET /pos/customers returns { items: Customer[] } — the same envelope as
    // /pos/sales. Unwrap here so callers receive a bare array. The old
    // req<Customer[]> cast was a lie (req returns the body verbatim, no
    // unwrap), so ClientesCajero's Array.isArray guard silently fell back to []
    // and the customer list always rendered empty.
    list: (search?: string): Promise<Customer[]> =>
      req<{ items: Customer[] }>(search ? `/pos/customers?search=${encodeURIComponent(search)}` : '/pos/customers').then(r => r.items ?? []),
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
    // Ficha de cliente: KPIs + linked sales / abonos / deliveries for the
    // slide-over panel. Same contract as the dashboard's getCustomerDetail.
    detail: (id: string) => req<CustomerDetail>(`/pos/customers/${id}/detail`),
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
