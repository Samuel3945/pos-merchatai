import { useState, useEffect, useCallback } from 'react';
import { api, Customer, CustomerDetail } from '../services/api';

const COP = (n: number | string) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
};

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: 'Pedido tomado',
  assigned: 'Tomado por el repartidor',
  in_transit: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '?';

type DetailTab = 'compras' | 'fiado' | 'domicilios';

interface FormState {
  name: string; documentId: string; whatsapp: string;
  email: string; address: string; notes: string;
}
const EMPTY: FormState = { name: '', documentId: '', whatsapp: '', email: '', address: '', notes: '' };

export default function ClientesCajero() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  const [showForm, setShowForm]   = useState(false);
  const [editId, setEditId]       = useState<string | null>(null);
  const [form, setForm]           = useState<FormState>(EMPTY);
  const [saving, setSaving]       = useState(false);

  // Slide-over "ficha de cliente". `detailOpen` controls the mount; `panelIn`
  // drives the enter/leave transform so the panel slides in from the right.
  const [detailOpen, setDetailOpen]       = useState(false);
  const [panelIn, setPanelIn]             = useState(false);
  const [detail, setDetail]               = useState<CustomerDetail | null>(null);
  const [detailName, setDetailName]       = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError]     = useState('');
  const [tab, setTab]                     = useState<DetailTab>('compras');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.customers.list(search.trim() || undefined);
      setCustomers(Array.isArray(r) ? r : []);
    } catch { setError('No se pudo cargar clientes'); }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const showOk = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  const openCreate = () => { setForm(EMPTY); setEditId(null); setError(''); setShowForm(true); };
  const openEdit   = (c: Customer) => {
    setForm({ name: c.name, documentId: c.document_id || '', whatsapp: c.whatsapp || '',
              email: c.email || '', address: c.address || '', notes: c.notes || '' });
    setEditId(c.id); setError(''); setShowForm(true);
  };

  const openDetail = async (c: Customer) => {
    setDetailName(c.name);
    setDetail(null);
    setDetailError('');
    setTab('compras');
    setDetailOpen(true);
    setDetailLoading(true);
    requestAnimationFrame(() => setPanelIn(true));
    try {
      const d = await api.customers.detail(c.id);
      setDetail(d);
    } catch (e: any) {
      setDetailError(e?.message || 'No se pudo cargar la ficha');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setPanelIn(false);
    setTimeout(() => { setDetailOpen(false); setDetail(null); }, 300);
  };

  const save = async () => {
    if (!form.name.trim()) { setError('El nombre es obligatorio'); return; }
    if (!form.documentId.trim() && !form.whatsapp.trim() && !form.email.trim()) {
      setError('Ingresa al menos documento, WhatsApp o correo');
      return;
    }
    setSaving(true); setError('');
    try {
      const data = {
        name: form.name, documentId: form.documentId, whatsapp: form.whatsapp,
        email: form.email, address: form.address, notes: form.notes,
      };
      if (editId) {
        await api.customers.update(editId, data);
        showOk('Cliente actualizado');
      } else {
        await api.customers.create(data);
        showOk('Cliente registrado');
      }
      setShowForm(false);
      load();
    } catch (e: any) { setError(e.message || 'Error al guardar'); }
    finally { setSaving(false); }
  };

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-6 space-y-4">

        {success && <div className="px-4 py-2.5 bg-success-soft border border-success/40 text-success rounded-xl text-sm font-semibold">{success}</div>}
        {error   && !showForm && <div className="px-4 py-2.5 bg-danger-soft/30 border border-danger text-danger rounded-xl text-sm">{error}</div>}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-ink font-black text-xl tracking-tight">Clientes</h1>
            <p className="text-ink-3 text-xs mt-0.5">Registra y consulta clientes para créditos y facturas.</p>
          </div>
          <button onClick={openCreate}
            className="flex items-center gap-1.5 h-9 px-4 bg-primary-soft hover:bg-primary-soft text-primary font-semibold rounded-xl text-sm transition-colors active:scale-95">
            <span className="material-symbols-outlined text-[16px]">person_add</span>
            Nuevo
          </button>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 bg-surface border border-line rounded-xl px-3 h-11">
          <span className="material-symbols-outlined text-ink-3 text-[20px]">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nombre, documento, WhatsApp…"
            className="flex-1 bg-transparent text-ink text-sm placeholder-ink-3 focus:outline-none" />
          {search && <button onClick={() => setSearch('')} className="text-ink-3"><span className="material-symbols-outlined text-[18px]">close</span></button>}
        </div>

        {/* List */}
        {loading ? (
          <div className="py-14 flex items-center justify-center text-ink-3">
            <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
          </div>
        ) : customers.length === 0 ? (
          <div className="py-14 text-center text-ink-3">
            <span className="material-symbols-outlined text-5xl block mb-3">groups</span>
            <p className="text-ink font-bold">Sin clientes registrados</p>
            <p className="text-sm mt-1">Agrega el primero con el botón "Nuevo"</p>
          </div>
        ) : (
          <div className="space-y-2">
            {customers.map(c => (
              <div key={c.id} onClick={() => openDetail(c)}
                className="bg-surface border border-line rounded-2xl px-4 py-3 cursor-pointer hover:border-primary/40 active:scale-[0.99] transition-all">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-ink font-semibold text-sm">{c.name}</div>
                    {c.document_id && <div className="text-ink-3 text-xs font-mono mt-0.5">{c.document_id}</div>}
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      {c.whatsapp && (
                        <span className="flex items-center gap-1 text-[11px] text-[#25D366]">
                          <span className="material-symbols-outlined text-[12px]">chat</span>{c.whatsapp}
                        </span>
                      )}
                      {c.email && (
                        <span className="flex items-center gap-1 text-[11px] text-ink-3 truncate max-w-[160px]">
                          <span className="material-symbols-outlined text-[12px]">mail</span>{c.email}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {c.total_spent > 0 && (
                      <span className="text-primary font-bold text-xs tabular-nums">{COP(c.total_spent)}</span>
                    )}
                    <button onClick={e => { e.stopPropagation(); openEdit(c); }}
                      className="p-1.5 text-ink-3 hover:text-primary hover:bg-surface-3 rounded-lg transition-colors">
                      <span className="material-symbols-outlined text-[16px]">edit</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ficha de cliente — slide-over from the right */}
      {detailOpen && (
        <div className={`fixed inset-0 z-50 flex justify-end transition-colors duration-200 ${panelIn ? 'bg-black/60' : 'bg-black/0'}`}
          onClick={closeDetail}>
          <div onClick={e => e.stopPropagation()}
            className={`w-full max-w-md h-full bg-bg border-l border-line shadow-2xl flex flex-col transition-transform duration-300 ease-out ${panelIn ? 'translate-x-0' : 'translate-x-full'}`}>

            {/* Header */}
            <div className="shrink-0 px-5 pt-5 pb-4 border-b border-line">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="shrink-0 w-11 h-11 rounded-full bg-primary-soft text-primary font-black flex items-center justify-center text-sm">
                    {initials(detail?.profile.name || detailName)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-ink font-black text-base truncate">{detail?.profile.name || detailName}</div>
                    <div className="text-ink-3 text-xs truncate">
                      {[detail?.profile.whatsapp, detail?.profile.documentId].filter(Boolean).join(' · ') || 'Sin contacto'}
                    </div>
                  </div>
                </div>
                <button onClick={closeDetail} className="p-1.5 text-ink-3 hover:text-ink rounded-lg shrink-0">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {/* KPI row */}
              <div className="grid grid-cols-4 gap-2 mt-4">
                <Kpi label="Gastado" value={COP(detail?.kpis.totalSpent ?? 0)} />
                <Kpi label="Compras" value={String(detail?.kpis.purchaseCount ?? 0)} />
                <Kpi label="Debe" value={COP(detail?.kpis.creditBalance ?? 0)}
                  tone={(detail?.kpis.creditBalance ?? 0) > 0 ? 'danger' : undefined} />
                <Kpi label="Última" value={detail?.kpis.lastPurchaseAt ? fmtDate(detail.kpis.lastPurchaseAt) : '—'} small />
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mt-4 bg-surface-2 p-1 rounded-xl">
                {([['compras', 'Compras'], ['fiado', 'Crédito'], ['domicilios', 'Domicilios']] as [DetailTab, string][]).map(([id, label]) => (
                  <button key={id} onClick={() => setTab(id)}
                    className={`flex-1 h-8 rounded-lg text-xs font-bold transition-colors ${tab === id ? 'bg-primary-soft text-primary' : 'text-ink-3 hover:text-ink'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detailLoading ? (
                <div className="py-14 flex items-center justify-center text-ink-3">
                  <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
                </div>
              ) : detailError ? (
                <div className="px-4 py-3 bg-danger-soft/30 border border-danger text-danger rounded-xl text-sm">{detailError}</div>
              ) : !detail ? null : tab === 'compras' ? (
                detail.recentSales.length === 0 ? (
                  <EmptyTab icon="receipt_long" text="Sin compras registradas" />
                ) : (
                  <div className="space-y-2">
                    {detail.recentSales.map(s => (
                      <div key={s.id} className="bg-surface border border-line rounded-2xl px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-ink font-semibold text-sm">
                              {s.saleNumber != null ? `Venta #${s.saleNumber}` : 'Venta'}
                            </div>
                            <div className="text-ink-3 text-[11px] mt-0.5">{fmtDate(s.date)}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {s.fullyReturned && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-danger-soft/40 text-danger">
                                <span className="material-symbols-outlined text-[11px]">undo</span>Devuelta
                              </span>
                            )}
                            <span className="text-ink font-bold text-sm tabular-nums">{COP(s.total)}</span>
                          </div>
                        </div>
                        <div className="mt-1">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-primary-soft text-primary">
                            {s.paymentType === 'cash' ? 'Efectivo' : s.paymentType}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : tab === 'fiado' ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between bg-surface border border-line rounded-2xl px-4 py-3">
                    <span className="text-ink-3 text-xs font-semibold uppercase tracking-wider">Saldo pendiente</span>
                    <span className={`font-black text-base tabular-nums ${detail.credito.balance > 0 ? 'text-danger' : 'text-success'}`}>
                      {COP(detail.credito.balance)}
                    </span>
                  </div>
                  {detail.credito.recentAbonos.length === 0 ? (
                    <EmptyTab icon="handshake" text="Sin abonos registrados" />
                  ) : (
                    <div className="space-y-2">
                      {detail.credito.recentAbonos.map(a => (
                        <div key={a.id} className="bg-surface border border-line rounded-2xl px-4 py-3 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-ink font-semibold text-sm capitalize">{a.method || 'Abono'}</div>
                            <div className="text-ink-3 text-[11px] mt-0.5">{fmtDate(a.date)}</div>
                          </div>
                          <span className="text-success font-bold text-sm tabular-nums">{COP(a.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                detail.deliveries.length === 0 ? (
                  <EmptyTab icon="local_shipping" text="Sin domicilios" />
                ) : (
                  <div className="space-y-2">
                    {detail.deliveries.map(d => (
                      <div key={d.id} className="bg-surface border border-line rounded-2xl px-4 py-3 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-ink font-semibold text-sm">{DELIVERY_STATUS_LABELS[d.status] ?? d.status}</div>
                          <div className="text-ink-3 text-[11px] mt-0.5">{fmtDate(d.date)}</div>
                        </div>
                        <span className="text-ink font-bold text-sm tabular-nums">{COP(d.total)}</span>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-md p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-bold text-ink text-lg">{editId ? 'Editar cliente' : 'Nuevo cliente'}</h2>
              <button onClick={() => setShowForm(false)} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {error && <div className="text-danger text-sm bg-danger-soft/30 border border-danger px-3 py-2 rounded-lg mb-4">{error}</div>}

            <div className="space-y-4">
              <Field label="Nombre completo *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Nombre y apellido" />
              <Field label="Documento (cédula / NIT)" value={form.documentId} onChange={v => setForm(f => ({ ...f, documentId: v }))} placeholder="1.234.567.890" />
              <Field label="WhatsApp" value={form.whatsapp} onChange={v => setForm(f => ({ ...f, whatsapp: v }))} placeholder="3001234567" />
              <Field label="Correo" type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="cliente@correo.com" />
              <Field label="Dirección" value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} placeholder="Cra 1 # 2-3" />
              <Field label="Notas" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} placeholder="Observaciones…" />
            </div>

            <div className="grid grid-cols-2 gap-2 mt-6">
              <button onClick={save} disabled={saving}
                className="h-12 bg-primary-soft hover:bg-primary-soft disabled:opacity-40 text-primary font-bold rounded-xl transition-colors">
                {saving ? 'Guardando…' : editId ? 'Actualizar' : 'Registrar'}
              </button>
              <button onClick={() => setShowForm(false)}
                className="h-12 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone, small }: {
  label: string; value: string; tone?: 'danger'; small?: boolean;
}) {
  return (
    <div className="bg-surface border border-line rounded-xl px-2 py-2 text-center">
      <div className="text-[9px] text-ink-3 font-bold uppercase tracking-wider truncate">{label}</div>
      <div className={`font-black tabular-nums mt-0.5 ${small ? 'text-[11px]' : 'text-xs'} ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{value}</div>
    </div>
  );
}

function EmptyTab({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="py-12 text-center text-ink-3">
      <span className="material-symbols-outlined text-4xl block mb-2">{icon}</span>
      <p className="text-sm">{text}</p>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
    </div>
  );
}
