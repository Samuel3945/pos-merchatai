import { useState, useEffect, useCallback, useRef } from 'react';
import { api, Sale, PaymentMethod, SalePayment } from '../services/api';
import type { PosSession } from '../lib/storage';
import CheckoutModal from '../components/CheckoutModal';
import DateRangePicker, {
  DateRange, presetToRange, toYMD,
} from '../components/DateRangePicker';

interface Props { session: PosSession; }

const LIMIT = 50;

function paymentBadgeClass(pt: string) {
  const p = (pt || '').toLowerCase();
  if (p === 'efectivo' || p === 'cash') return 'bg-success-soft text-success';
  if (/cr[ée]dito|fiado/.test(p))         return 'bg-warn-soft text-warn';
  if (p.includes('transfer') || p.includes('nequi') || p.includes('daviplata') ||
      p.includes('llave') || p.includes('banco'))
    return 'bg-primary-soft text-primary';
  return 'bg-primary-soft text-primary';
}

function relativeDate(iso: string) {
  const d = new Date(iso);
  const bogota = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
  const dayD = new Date(d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
  const diff = Math.round((bogota.getTime() - dayD.getTime()) / 86400000);
  const time = d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
  if (diff === 0) return `Hoy ${time}`;
  if (diff === 1) return `Ayer ${time}`;
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', timeZone: 'America/Bogota' }) + ` ${time}`;
}

function parseCreditoNotes(notes: string | null) {
  if (!notes) return null;
  return notes.split(' | ').map(p => p.trim()).filter(Boolean);
}

// A sale can only be corrected ("error de carga") within the current shift.
// The backend enforces the exact open-session boundary; here we use "today in
// Bogotá" as a cheap proxy so the action only shows on plausibly-correctable
// sales (the session has no opened-at on the client).
function isToday(iso: string) {
  if (!iso) return false;
  const saleDay = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  return saleDay === today;
}

function formatQty(qty: number | string, unitType?: 'unit' | 'kg') {
  const n = Number(qty);
  if (!Number.isFinite(n)) return String(qty);
  if (unitType === 'kg') {
    const trimmed = n.toString();
    return `${trimmed}kg`;
  }
  return String(Math.round(n));
}

// ── Return modal ──────────────────────────────────────────────────────────────

// Only the two curated reasons the admin panel offers: customer_request returns
// the item to stock; damaged is an exchange (no refund) that leaves as merma.
const RETURN_REASONS = [
  { value: 'customer_request', label: 'Cambio de opinión del cliente' },
  { value: 'damaged',          label: 'Producto dañado' },
];

interface ReturnRequest {
  reason: string;
  refundMethod: string;
  items: Array<{ saleItemId: string; qty: number; refundAmount: number; disposition?: 'restock' | 'damaged' | 'discard'; restock?: boolean }>;
  notes?: string;
  partial: boolean;
}

function defaultRange(): DateRange {
  const r = presetToRange('last30');
  return { ...r, label: 'Últimos 30 días' };
}

export default function VentasCajero({ session }: Props) {
  const cashierId = session.cash.cashierId || undefined;

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [hasTransfer, setHasTransfer] = useState(false);
  const dateStart = toYMD(range.start);
  const dateEnd = toYMD(range.end);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ items: Sale[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Return modal
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [returnNotes, setReturnNotes] = useState('');
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnSuccess, setReturnSuccess] = useState('');
  const [returnSelected, setReturnSelected] = useState<Set<number>>(new Set());
  const [returnQtys, setReturnQtys] = useState<Record<number, number>>({});
  const [returnReason, setReturnReason] = useState<string>('customer_request');
  const [returnRefundMethod, setReturnRefundMethod] = useState<string>('');
  const [returnError, setReturnError] = useState<string>('');
  const [refundPaymentMethods, setRefundPaymentMethods] = useState<PaymentMethod[]>([]);
  // Payment correction — reuses the POS checkout so the cashier re-enters the
  // method split (mixto / change of method) the same way they charge.
  const [correctSale, setCorrectSale] = useState<Sale | null>(null);
  const [correctMethods, setCorrectMethods] = useState<PaymentMethod[]>([]);
  const [correctCanConfirmTransfers, setCorrectCanConfirmTransfers] = useState(true);
  const [correctCreditoEnabled, setCorrectCreditoEnabled] = useState(false);
  const [correctCreditoTermDays, setCorrectCreditoTermDays] = useState(30);
  const [correctLoading, setCorrectLoading] = useState(false);

  useEffect(() => {
    api.pos.paymentMethods().then(methods => {
      const transferTypes = ['transfer', 'nequi', 'llave'];
      setHasTransfer((methods || []).some(m => m.active && transferTypes.includes(m.type)));
    }).catch(() => {});
  }, []);

  const load = useCallback(async (
    currentSearch: string,
    currentStart: string,
    currentEnd: string,
    currentPage: number,
  ) => {
    setLoading(true);
    try {
      const r = await api.sales.list({
        limit: LIMIT,
        offset: currentPage * LIMIT,
        search: currentSearch.trim() || undefined,
        start: currentStart || undefined,
        end: currentEnd || undefined,
        cashierId,
        paymentType: paymentFilter || undefined,
      });
      if (Array.isArray(r)) {
        setResult({ items: r, total: r.length });
      } else {
        setResult(r);
      }
    } catch {
      setResult({ items: [], total: 0 });
    } finally {
      setLoading(false);
    }
  }, [cashierId]);

  useEffect(() => {
    load(debouncedSearch, dateStart, dateEnd, page);
  }, [debouncedSearch, dateStart, dateEnd, page, paymentFilter, load]);

  const handleSearchChange = (v: string) => {
    setSearch(v);
    setPage(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(v), 300);
  };
  const handleRangeChange = (r: DateRange) => { setRange(r); setPage(0); };
  const clearFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setPaymentFilter('');
    setRange(defaultRange());
    setPage(0);
  };

  const openCorrection = (sale: Sale) => {
    setCorrectSale(sale);
    // Load the catalog + transfer-confirm permission + fiado settings so the
    // checkout shows the same tiles the cashier uses to charge. Correcting INTO
    // fiado books the debt (backend createCredito), so the modal captures the
    // client; the single fiado tile is the synthetic one.
    api.pos.me().then(me => {
      setCorrectMethods(Array.isArray(me?.paymentMethods) ? me.paymentMethods : []);
      setCorrectCanConfirmTransfers(me?.features?.canConfirmTransfers !== false);
      setCorrectCreditoEnabled(!!me?.features?.creditoEnabled);
      setCorrectCreditoTermDays(
        typeof me?.store?.creditoTermDays === 'number' ? me.store.creditoTermDays : 30,
      );
    }).catch(() => {
      setCorrectMethods([]);
      setCorrectCanConfirmTransfers(true);
      setCorrectCreditoEnabled(false);
    });
  };

  const submitCorrection = async (payments: SalePayment[], notes?: string, dueDate?: string | null) => {
    if (!correctSale) return;
    setCorrectLoading(true);
    try {
      await api.sales.resplit(correctSale.id, payments, notes, dueDate);
      setCorrectSale(null);
      load(search, dateStart, dateEnd, page);
    } finally {
      setCorrectLoading(false);
    }
  };

  const hasFilters = !!(search || paymentFilter);
  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const from = page * LIMIT + 1;
  const to = Math.min((page + 1) * LIMIT, total);
  const totalValue = items.reduce((s, v) => s + Number(v.total), 0);

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="max-w-5xl mx-auto px-6 py-6 pb-24 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-ink font-black text-2xl tracking-tight">Mis ventas</h1>
            <p className="text-ink-3 text-xs mt-0.5">
              Solo se muestran las ventas que registraste tú.
            </p>
          </div>
          <span className="text-ink-3 text-sm">
            {new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })}
          </span>
        </div>

        {/* Filter bar */}
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[220px]">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-[18px]">search</span>
              <input
                value={search}
                onChange={e => handleSearchChange(e.target.value)}
                placeholder="Buscar por producto, cliente o #ID..."
                className="w-full bg-surface border border-line rounded-xl h-10 pl-9 pr-3 text-ink text-sm focus:border-primary transition-colors"
              />
            </div>
            <DateRangePicker
              range={range}
              onRangeChange={handleRangeChange}
            />
            {hasFilters && (
              <button onClick={clearFilters}
                className="flex items-center gap-1.5 h-10 px-3 bg-surface border border-line hover:border-danger text-ink-3 hover:text-danger text-sm font-medium rounded-xl transition-colors">
                <span className="material-symbols-outlined text-[16px]">close</span>
                Limpiar
              </button>
            )}
          </div>

          {/* Payment method chips */}
          <div className="flex items-center gap-2 flex-wrap">
            {([
              { value: '',          label: 'Todos',         icon: 'all_inclusive',  show: true },
              { value: 'efectivo',  label: 'Efectivo',      icon: 'payments',       show: true },
              { value: 'transfer',  label: 'Transferencia', icon: 'swap_horiz',     show: hasTransfer },
              { value: 'credito',     label: 'Crédito',         icon: 'handshake',      show: true },
            ] as const).filter(opt => opt.show).map(opt => (
              <button key={opt.value}
                onClick={() => { setPaymentFilter(opt.value); setPage(0); }}
                className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-colors border ${
                  paymentFilter === opt.value
                    ? opt.value === ''         ? 'bg-surface border-primary text-primary'
                    : opt.value === 'efectivo' ? 'bg-success-soft/60 border-success text-success'
                    : opt.value === 'credito'    ? 'bg-warn-soft/60 border-warn text-warn'
                    : 'bg-primary-soft/60 border-primary text-primary'
                    : 'bg-transparent border-line text-ink-3 hover:border-line-strong hover:text-ink-2'
                }`}>
                <span className="material-symbols-outlined text-[14px]">{opt.icon}</span>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Results summary */}
        {!loading && result && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-3">
              {total === 0 ? 'Sin resultados' : `${total} venta${total !== 1 ? 's' : ''} · `}
              {total > 0 && <span className="text-success font-semibold">+${totalValue.toLocaleString('es-CO')}</span>}
            </span>
            {total > 0 && totalPages > 1 && (
              <span className="text-ink-3 text-xs">{from}–{to} de {total}</span>
            )}
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-ink-3">
            <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
            Cargando...
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-20 text-ink-3">
            <span className="material-symbols-outlined text-5xl block mb-3">receipt_long</span>
            <p>Sin ventas{hasFilters ? ' con estos filtros' : ' registradas'}</p>
            {hasFilters && (
              <button onClick={clearFilters} className="mt-2 text-primary text-sm font-semibold hover:underline">
                Limpiar filtros
              </button>
            )}
          </div>
        ) : (
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-line bg-bg/50">
                  <th className="px-5 py-3.5 text-ink-3 text-xs font-semibold uppercase tracking-wider">#</th>
                  <th className="px-5 py-3.5 text-ink-3 text-xs font-semibold uppercase tracking-wider">Fecha y hora</th>
                  <th className="px-5 py-3.5 text-ink-3 text-xs font-semibold uppercase tracking-wider">Productos</th>
                  <th className="px-5 py-3.5 text-ink-3 text-xs font-semibold uppercase tracking-wider">Método</th>
                  <th className="px-5 py-3.5 text-ink-3 text-xs font-semibold uppercase tracking-wider text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map(sale => {
                  const isCredito = /cr[ée]dito|fiado/i.test(sale.paymentType ?? '');
                  const creditoInfo = isCredito ? parseCreditoNotes(sale.notes) : null;
                  const isExpanded = expanded === sale.id;
                  const itemNames = (sale.items ?? [])
                    .slice(0, 2)
                    .map(it => `${it.productName} ×${formatQty(it.qty, it.unitType)}`)
                    .join(', ');
                  const extraItems = (sale.items?.length ?? 0) - 2;

                  return (
                    <>
                      <tr key={sale.id}
                        onClick={() => setExpanded(isExpanded ? null : sale.id)}
                        className="hover:bg-surface-3 transition-colors cursor-pointer group">
                        <td className="px-5 py-3.5">
                          <span className="text-primary font-mono text-sm font-bold group-hover:underline">
                            #{sale.id.slice(0, 6).toUpperCase()}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-ink-3 text-sm whitespace-nowrap">
                          {sale.createdAt ? relativeDate(sale.createdAt) : '—'}
                        </td>
                        <td className="px-5 py-3.5">
                          <span className="text-ink-2 text-sm truncate max-w-[220px] block">
                            {itemNames || '—'}
                            {extraItems > 0 && <span className="text-ink-3"> +{extraItems} más</span>}
                          </span>
                          {isCredito && creditoInfo?.[0] && (
                            <span className="text-warn text-xs">{creditoInfo[0].replace('Cliente: ', '')}</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${paymentBadgeClass(sale.paymentType)}`}>
                              {isCredito && <span className="material-symbols-outlined text-[11px]">handshake</span>}
                              {sale.paymentType === 'cash' ? 'Efectivo' : sale.paymentType}
                            </span>
                            <EInvoiceBadge sale={sale} onChanged={() => load(search, dateStart, dateEnd, page)} />
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-success font-bold text-sm">
                            +${Number(sale.total).toLocaleString('es-CO')}
                          </span>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr key={`${sale.id}-detail`} className="bg-bg/50">
                          <td colSpan={5} className="px-8 py-3 space-y-2">
                            {isCredito && creditoInfo && creditoInfo.length > 1 && (
                              <div className="flex flex-wrap gap-2 pb-2 border-b border-line">
                                {creditoInfo.map((info, i) => (
                                  <span key={i} className="flex items-center gap-1 text-xs text-warn bg-warn-soft/40 px-2.5 py-1 rounded-lg">
                                    <span className="material-symbols-outlined text-[11px]">
                                      {info.startsWith('Cliente:') ? 'person' : info.startsWith('Tel:') ? 'phone' : 'note'}
                                    </span>
                                    {info}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="space-y-1">
                              {(sale.items ?? []).map((item, i) => (
                                <div key={i} className="flex items-center justify-between text-sm">
                                  <span className="text-ink-2">{item.productName} × {formatQty(item.qty, item.unitType)}</span>
                                  <span className="text-ink-3 font-mono">${Number(item.subtotal).toLocaleString('es-CO')}</span>
                                </div>
                              ))}
                            </div>
                            {(sale.payments?.length ?? 0) > 0 && (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-ink-3 text-xs">Pagos:</span>
                                {(sale.payments ?? []).map((p, i) => (
                                  <span key={i} className="text-xs text-ink-2 bg-surface-2 px-2 py-0.5 rounded-lg">
                                    {p.method} ${Number(p.amount).toLocaleString('es-CO')}
                                  </span>
                                ))}
                                {isToday(sale.createdAt) && sale.status !== 'returned' && !isCredito && (
                                  <button
                                    onClick={e => { e.stopPropagation(); openCorrection(sale); }}
                                    className="ml-auto flex items-center gap-1 text-[10px] font-semibold text-primary bg-primary-soft/40 hover:bg-primary-soft/70 px-2 py-1 rounded-lg transition-colors">
                                    <span className="material-symbols-outlined text-[12px]">swap_horiz</span>
                                    Cambiar método de pago
                                  </button>
                                )}
                              </div>
                            )}
                            <div className="flex justify-between border-t border-line pt-2 mt-1 items-center">
                              <span className="text-ink-3 text-xs">Total</span>
                              <div className="flex items-center gap-3">
                                <span className="text-success font-bold text-sm">${Number(sale.total).toLocaleString('es-CO')}</span>
                                {(() => {
                                  const allReturned = sale.status === 'returned' ||
                                    ((sale.items ?? []).length > 0 &&
                                    (sale.items ?? []).every(it => (it.returnedQty ?? 0) >= Number(it.qty)));
                                  const someReturned = !allReturned && (sale.items ?? []).some(it => (it.returnedQty ?? 0) > 0);
                                  if (allReturned) return (
                                    <span className="flex items-center gap-1 text-[10px] font-semibold text-ink-3 bg-surface-3 px-2 py-1 rounded-lg cursor-default">
                                      <span className="material-symbols-outlined text-[12px]">check_circle</span>
                                      Devuelta
                                    </span>
                                  );
                                  return (
                                    <button
                                      onClick={e => {
                                        e.stopPropagation();
                                        setReturnSale(sale);
                                        setReturnNotes('');
                                        setReturnSuccess('');
                                        setReturnError('');
                                        const selectable = new Set<number>();
                                        const qtys: Record<number, number> = {};
                                        (sale.items ?? []).forEach((it, i) => {
                                          const remaining = Number(it.qty) - (it.returnedQty ?? 0);
                                          if (remaining > 0) { selectable.add(i); qtys[i] = remaining; }
                                        });
                                        setReturnSelected(selectable);
                                        setReturnQtys(qtys);
                                        api.pos.paymentMethods().then(methods => {
                                          const systemEfectivo: PaymentMethod = {
                                            id: 'system-cash', name: 'Efectivo', type: 'cash',
                                            icon: 'payments', active: true,
                                            sort_order: 0, details: null, description: null,
                                          };
                                          const rest = (Array.isArray(methods) ? methods : [])
                                            .filter(m => m.active && m.type !== 'credito' && m.type !== 'cash');
                                          setRefundPaymentMethods([systemEfectivo, ...rest]);
                                          setReturnRefundMethod('Efectivo');
                                        }).catch(() => {
                                          setRefundPaymentMethods([{
                                            id: 'system-cash', name: 'Efectivo', type: 'cash',
                                            icon: 'payments', active: true,
                                            sort_order: 0, details: null, description: null,
                                          }]);
                                          setReturnRefundMethod('Efectivo');
                                        });
                                      }}
                                      className="flex items-center gap-1 text-[10px] font-semibold text-warn bg-warn-soft/40 hover:bg-warn-soft/70 px-2 py-1 rounded-lg transition-colors">
                                      <span className="material-symbols-outlined text-[12px]">undo</span>
                                      {someReturned ? 'Dev. parcial' : 'Devolución'}
                                    </button>
                                  );
                                })()}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-5 py-3.5 border-t border-line bg-bg/30 flex items-center justify-between">
                <span className="text-ink-3 text-xs">{from}–{to} de {total} ventas</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                    className="flex items-center gap-1 h-8 px-3 bg-surface-2 border border-line text-ink-2 hover:text-primary hover:border-primary text-xs font-semibold rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    <span className="material-symbols-outlined text-[16px]">chevron_left</span>
                    Anterior
                  </button>
                  <span className="text-ink-3 text-xs px-1">{page + 1} / {totalPages}</span>
                  <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
                    className="flex items-center gap-1 h-8 px-3 bg-surface-2 border border-line text-ink-2 hover:text-primary hover:border-primary text-xs font-semibold rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    Siguiente
                    <span className="material-symbols-outlined text-[16px]">chevron_right</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Return modal ── */}
      {returnSale && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-line rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-ink">Procesar devolución</h2>
                <p className="text-ink-3 text-xs mt-0.5">
                  Venta #{returnSale.id.slice(0,6).toUpperCase()} · ${Number(returnSale.total).toLocaleString('es-CO')}
                </p>
              </div>
              <button onClick={() => setReturnSale(null)} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {returnSuccess ? (
              <div className="text-center py-4">
                <span className="material-symbols-outlined text-success text-4xl block mb-2">check_circle</span>
                <p className="text-success font-semibold">Devolución registrada</p>
                <p className="text-ink-3 text-xs mt-1">El stock fue actualizado en inventario</p>
                <button onClick={() => setReturnSale(null)} className="mt-4 h-10 px-6 bg-success-soft text-success font-bold rounded-xl hover:bg-success-soft transition-colors">
                  Cerrar
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <p className="text-ink-3 text-xs font-semibold uppercase tracking-wider">Selecciona qué se devuelve</p>
                  {(returnSale.items ?? []).map((item, i) => {
                    const alreadyReturned = item.returnedQty ?? 0;
                    const maxReturnable = Number(item.qty) - alreadyReturned;
                    const fullyReturned = maxReturnable <= 0;
                    const checked = returnSelected.has(i) && !fullyReturned;
                    const qty = returnQtys[i] ?? maxReturnable;
                    return (
                      <div key={i} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${fullyReturned ? 'bg-bg border-line opacity-40 cursor-not-allowed' : checked ? 'bg-primary-soft/20 border-primary/30' : 'bg-bg border-line opacity-50'}`}>
                        <input type="checkbox" checked={checked} disabled={fullyReturned}
                          onChange={e => {
                            const next = new Set(returnSelected);
                            e.target.checked ? next.add(i) : next.delete(i);
                            if (e.target.checked && !returnQtys[i]) {
                              setReturnQtys(q => ({ ...q, [i]: maxReturnable }));
                            }
                            setReturnSelected(next);
                          }}
                          className="w-4 h-4 rounded accent-[#9acee1] cursor-pointer disabled:cursor-not-allowed" />
                        <div className="flex-1 min-w-0">
                          <span className="text-ink-2 text-sm block truncate">{item.productName}</span>
                          {alreadyReturned > 0 && (
                            <span className="text-[10px] text-danger font-semibold">
                              {formatQty(alreadyReturned, item.unitType)} ya devuelta{alreadyReturned > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        {fullyReturned ? (
                          <span className="text-[10px] text-ink-3 font-semibold px-2">Devuelto</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button onClick={() => setReturnQtys(q => ({ ...q, [i]: Math.max(1, (q[i] ?? maxReturnable) - 1) }))}
                              disabled={!checked}
                              className="w-6 h-6 bg-surface-3 rounded-lg text-ink-3 text-sm font-bold disabled:opacity-30">−</button>
                            <span className="text-ink font-bold text-sm w-10 text-center tabular-nums">{formatQty(qty, item.unitType)}</span>
                            <button onClick={() => setReturnQtys(q => ({ ...q, [i]: Math.min(maxReturnable, (q[i] ?? maxReturnable) + 1) }))}
                              disabled={!checked}
                              className="w-6 h-6 bg-surface-3 rounded-lg text-ink-3 text-sm font-bold disabled:opacity-30">+</button>
                          </div>
                        )}
                        <span className="text-ink-3 text-xs font-mono w-20 text-right">
                          {fullyReturned
                            ? '—'
                            : returnReason === 'damaged'
                              ? 'Merma'
                              : `$${Number(Number(item.subtotal) / Number(item.qty) * qty).toLocaleString('es-CO')}`}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">
                      Motivo <span className="text-danger">*</span>
                    </label>
                    <select value={returnReason} onChange={e => setReturnReason(e.target.value)}
                      className="w-full bg-bg border border-line rounded-xl px-3 py-2.5 text-ink text-sm focus:border-primary">
                      {RETURN_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">
                      Reembolso en {returnReason !== 'damaged' && <span className="text-danger">*</span>}
                    </label>
                    {returnReason === 'damaged' ? (
                      <div className="w-full bg-bg border border-line rounded-xl px-3 py-2.5 text-ink-3 text-sm">
                        No aplica (merma)
                      </div>
                    ) : (
                      <select value={returnRefundMethod} onChange={e => setReturnRefundMethod(e.target.value)}
                        className="w-full bg-bg border border-line rounded-xl px-3 py-2.5 text-ink text-sm focus:border-primary"
                        disabled={refundPaymentMethods.length === 0}>
                        {refundPaymentMethods.length === 0
                          ? <option value="">Cargando...</option>
                          : refundPaymentMethods.map(m => <option key={m.id} value={m.name}>{m.name}</option>)
                        }
                      </select>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">
                    Notas <span className="text-ink-4">(opcional)</span>
                  </label>
                  <input type="text" value={returnNotes} onChange={e => setReturnNotes(e.target.value)}
                    placeholder="Detalle adicional..."
                    className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary transition-colors" />
                </div>

                <div className="bg-warn-soft/20 border border-warn/20 rounded-xl p-3 text-warn text-xs">
                  <span className="material-symbols-outlined text-[14px] align-middle mr-1">info</span>
                  {returnReason === 'damaged'
                    ? 'Producto dañado: no se devuelve dinero. Sale del stock como merma, valuada al costo.'
                    : refundPaymentMethods.find(m => m.name === returnRefundMethod)?.type === 'cash'
                      ? 'Se restocará inventario y se registrará la salida de efectivo en la caja abierta.'
                      : 'Se restocará inventario. El reembolso quedará registrado en el método indicado.'}
                </div>

                {returnError && (
                  <div className="bg-danger-soft/30 border border-danger text-danger px-3 py-2 rounded-xl text-sm">
                    {returnError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={async () => {
                      setReturnLoading(true); setReturnError('');
                      try {
                        const allItems = returnSale.items ?? [];
                        const selectedIdxs = [...returnSelected];
                        // Mirror the admin panel: the destination is baked into the
                        // reason. A change of mind restocks and refunds; a damaged
                        // product leaves as merma with no refund. Send an explicit
                        // disposition instead of relying on the backend to override
                        // a hardcoded restock.
                        const disposition: 'restock' | 'damaged' | 'discard' = returnReason === 'damaged' ? 'damaged' : 'restock';
                        const returnItems = selectedIdxs.map(origIdx => {
                          const it = allItems[origIdx];
                          const maxReturnable = Number(it.qty) - (it.returnedQty ?? 0);
                          const qty = Math.min(returnQtys[origIdx] ?? maxReturnable, maxReturnable);
                          const fullQty = Number(it.qty) || 1;
                          const refundAmount = disposition === 'damaged'
                            ? 0
                            : Math.round((Number(it.subtotal) / fullQty * qty) * 100) / 100;
                          return {
                            saleItemId: it.id,
                            qty,
                            refundAmount,
                            disposition,
                            restock: disposition === 'restock',
                          };
                        });
                        const partial = !allItems.every((it, origIdx) => {
                          const alreadyReturned = it.returnedQty ?? 0;
                          const nowReturning = returnSelected.has(origIdx) ? (returnQtys[origIdx] ?? (Number(it.qty) - alreadyReturned)) : 0;
                          return alreadyReturned + nowReturning >= Number(it.qty);
                        });
                        await api.sales.processReturn(returnSale.id, {
                          reason: returnReason,
                          refundMethod: returnRefundMethod,
                          notes: returnNotes || undefined,
                          partial,
                          items: returnItems,
                        });
                        setReturnSuccess(partial ? 'Devolución parcial registrada' : 'Devolución registrada');
                        setReturnSale(null);
                        setReturnSelected(new Set());
                        setReturnQtys({});
                        setReturnNotes('');
                        load(search, dateStart, dateEnd, page);
                        setTimeout(() => setReturnSuccess(''), 4000);
                      } catch (e: any) {
                        setReturnError(e?.message || 'No se pudo procesar la devolución');
                      } finally { setReturnLoading(false); }
                    }}
                    disabled={returnLoading || returnSelected.size === 0}
                    className="h-12 bg-warn-soft/60 hover:bg-warn-soft disabled:opacity-40 text-warn font-bold rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-[16px]">undo</span>
                    {returnLoading ? 'Procesando...' : 'Confirmar devolución'}
                  </button>
                  <button onClick={() => { setReturnSale(null); setReturnError(''); }}
                    className="h-12 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                    Cancelar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Payment correction — reuses the POS checkout ── */}
      {correctSale && (
        <CheckoutModal
          mode="correction"
          total={Number(correctSale.total)}
          initialPayments={(correctSale.payments ?? []).map(p => ({
            method: p.method,
            amount: Number(p.amount),
            reference: p.reference ?? null,
            changeGiven: Number(p.changeGiven ?? 0),
          }))}
          paymentMethods={correctMethods}
          creditoEnabled={correctCreditoEnabled}
          creditoTermDays={correctCreditoTermDays}
          canConfirmTransfers={correctCanConfirmTransfers}
          loading={correctLoading}
          onConfirm={submitCorrection}
          onCancel={() => setCorrectSale(null)}
        />
      )}
    </div>
  );
}

// ── Badge de factura electrónica ──────────────────────────────────────────────

function EInvoiceBadge({ sale, onChanged }: { sale: Sale; onChanged: () => void }) {
  const status = sale.einvoiceStatus;

  if (!status || status === 'not_requested') return null;

  const meta = {
    pending:   { label: 'FE pendiente', icon: 'schedule',     cls: 'bg-warn-soft/40 text-warn' },
    emitted:   { label: 'FE emitida',   icon: 'verified',     cls: 'bg-success-soft/60 text-success' },
    failed:    { label: 'FE falló',     icon: 'error',        cls: 'bg-danger-soft/30 text-danger' },
    cancelled: { label: 'FE anulada',   icon: 'block',        cls: 'bg-surface-2 text-ink-3' },
  }[status]!;

  // Suppress unused variable warning
  void onChanged;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${meta.cls}`}>
      <span className="material-symbols-outlined text-[12px]">{meta.icon}</span>
      {meta.label}
    </span>
  );
}
