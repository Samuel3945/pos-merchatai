import { useState, useEffect, useCallback } from 'react';
import { api, FiadoClient, FiadoHistoryItem, PaymentMethod } from '../services/api';

const COP = (n: number) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

const RISK_COLORS: Record<string, string> = {
  high: 'text-danger bg-danger-soft/20 border-danger/40',
  mid:  'text-warn bg-warn-soft/20 border-warn/40',
  low:  'text-success bg-success-soft/20 border-success/40',
};

const DEFAULT_METHOD: PaymentMethod = {
  id: 'efectivo', name: 'Efectivo', type: 'cash', icon: 'payments',
  active: true, sort_order: 0,
  details: null, description: null,
};

function colorForType(type: string): string {
  switch (type) {
    case 'cash':     return 'text-success';
    case 'transfer':
    case 'nequi':
    case 'llave':    return 'text-primary';
    default:         return 'text-ink-2';
  }
}

function isAvailableNow(pm: PaymentMethod): boolean {
  if (!pm.active) return false;
  if (pm.type === 'fiado') return false;
  return true;
}

export default function FiadosCajero() {
  const [clients, setClients]         = useState<FiadoClient[]>([]);
  const [stats, setStats]             = useState<Record<string, number>>({});
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [paymentOptions, setPaymentOptions] = useState<PaymentMethod[]>([DEFAULT_METHOD]);
  const [activeTab, setActiveTab]     = useState<'pendientes' | 'historial'>('pendientes');
  const [history, setHistory]         = useState<FiadoHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Modal pago / saldar
  const [selected, setSelected]       = useState<FiadoClient | null>(null);
  const [mode, setMode]               = useState<'abonar' | 'saldar'>('abonar');
  const [method, setMethod]           = useState('Efectivo');
  const [busy, setBusy]               = useState(false);

  // Abono — monto y preview
  const [abonoAmount, setAbonoAmount] = useState('');
  const [abonoError, setAbonoError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.fiados.list();
      setClients(d.clients || []);
      setStats(d.stats || {});
    } catch { setError('No se pudo cargar los fiados'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.pos.me()
      .then(me => {
        const available = (me.paymentMethods || []).filter(isAvailableNow);
        const hasCash = available.some(pm => pm.type === 'cash' || pm.name.toLowerCase() === 'efectivo');
        setPaymentOptions(hasCash ? available : [DEFAULT_METHOD, ...available]);
      })
      .catch(() => setPaymentOptions([DEFAULT_METHOD]));
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory(await api.fiados.history());
    } catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => { if (activeTab === 'historial') loadHistory(); }, [activeTab, loadHistory]);

  const showOk = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3500); };

  const openAbonar = (c: FiadoClient) => {
    setSelected(c); setMode('abonar');
    setAbonoAmount(''); setAbonoError(''); setError('');
    setMethod(paymentOptions[0]?.name ?? 'Efectivo');
  };

  const openSaldar = (c: FiadoClient) => {
    setSelected(c); setMode('saldar'); setError('');
    setMethod(paymentOptions[0]?.name ?? 'Efectivo');
  };

  const handlePay = async () => {
    if (!selected) return;

    if (mode === 'abonar') {
      const cleaned = abonoAmount.replace(/[^\d.]/g, '');
      const amt = Number(cleaned);
      if (!Number.isFinite(amt) || amt <= 0) { setAbonoError('Ingresa un monto válido'); return; }
      if (amt > selected.total_owed + 0.5) {
        setAbonoError(`El monto supera la deuda (${COP(selected.total_owed)}). Usa "Saldar".`);
        return;
      }
      setBusy(true); setAbonoError('');
      try {
        await api.fiados.abonar(selected.id, amt, method);
        setSelected(null); setAbonoAmount('');
        showOk(`Abono de ${COP(amt)} registrado`);
        load();
      } catch (e: any) { setAbonoError(e.message || 'Error al registrar abono'); }
      finally { setBusy(false); }
    } else {
      setBusy(true); setError('');
      try {
        await api.fiados.settle(selected.id, method);
        setSelected(null);
        showOk('Fiado saldado completamente');
        load();
      } catch (e: any) { setError(e.message || 'Error al saldar'); }
      finally { setBusy(false); }
    }
  };

  const filtered = clients.filter(c =>
    !search || c.client_name.toLowerCase().includes(search.toLowerCase()) ||
    (c.client_phone || '').includes(search)
  );

  // Abono preview
  const abonoNum = Number((abonoAmount || '').replace(/[^\d.]/g, ''));
  const validAbono = Number.isFinite(abonoNum) && abonoNum > 0 && selected ? abonoNum <= selected.total_owed + 0.5 : false;
  const abonoRemaining = selected && validAbono ? Math.max(0, selected.total_owed - abonoNum) : (selected?.total_owed ?? 0);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-ink-3">
        <span className="material-symbols-outlined text-3xl animate-spin">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-6 space-y-4">

        {success && <div className="px-4 py-2.5 bg-success-soft border border-success/40 text-success rounded-xl text-sm font-semibold">{success}</div>}
        {error   && <div className="px-4 py-2.5 bg-danger-soft/30 border border-danger text-danger rounded-xl text-sm">{error}</div>}

        {/* Tabs */}
        <div className="flex gap-1 bg-surface border border-line rounded-xl p-1">
          <button onClick={() => setActiveTab('pendientes')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${activeTab === 'pendientes' ? 'bg-primary-soft text-primary' : 'text-ink-3 hover:text-ink'}`}>
            Pendientes
          </button>
          <button onClick={() => setActiveTab('historial')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${activeTab === 'historial' ? 'bg-success-soft text-success' : 'text-ink-3 hover:text-ink'}`}>
            Historial
          </button>
        </div>

        {activeTab === 'historial' ? (
          /* ── Historial de fiados saldados ── */
          historyLoading ? (
            <div className="flex items-center justify-center py-16">
              <span className="material-symbols-outlined text-3xl animate-spin text-ink-3">progress_activity</span>
            </div>
          ) : history.length === 0 ? (
            <div className="py-16 text-center text-ink-3">
              <span className="material-symbols-outlined text-5xl block mb-3">history</span>
              <p className="text-ink font-bold">Sin historial aún</p>
              <p className="text-xs mt-1">Los fiados saldados aparecerán aquí</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map(h => (
                <div key={h.id} className="bg-surface border border-success/40 rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-ink font-bold text-sm">{h.client_name}</div>
                      {h.client_phone && <div className="text-ink-3 text-xs mt-0.5">{h.client_phone}</div>}
                      <div className="text-ink-4 text-[10px] mt-1">
                        Generado: {new Date(h.created_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {' · '}
                        Saldado: {new Date(h.settled_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-black text-lg tabular-nums text-success">{COP(h.total)}</div>
                      <div className="text-success text-[10px] font-semibold flex items-center gap-0.5 justify-end">
                        <span className="material-symbols-outlined text-[12px]">check_circle</span>
                        Saldado
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
        <>
        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-surface border border-line rounded-xl p-3 text-center">
            <div className="text-danger font-black text-xl tabular-nums">{stats.high_risk || 0}</div>
            <div className="text-ink-3 text-[10px] uppercase tracking-wide mt-0.5">Urgentes</div>
          </div>
          <div className="bg-surface border border-line rounded-xl p-3 text-center">
            <div className="text-warn font-black text-xl tabular-nums">{stats.mid_risk || 0}</div>
            <div className="text-ink-3 text-[10px] uppercase tracking-wide mt-0.5">Pendientes</div>
          </div>
          <div className="bg-surface border border-line rounded-xl p-3 text-center">
            <div className="text-primary font-black text-xl tabular-nums">{COP(stats.total_owed || 0)}</div>
            <div className="text-ink-3 text-[10px] uppercase tracking-wide mt-0.5">Total</div>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 bg-surface border border-line rounded-xl px-3 h-11">
          <span className="material-symbols-outlined text-ink-3 text-[20px]">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente…"
            className="flex-1 bg-transparent text-ink text-sm placeholder-ink-3 focus:outline-none" />
          {search && <button onClick={() => setSearch('')} className="text-ink-3"><span className="material-symbols-outlined text-[18px]">close</span></button>}
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-ink-3">
            <span className="material-symbols-outlined text-5xl block mb-3">handshake</span>
            <p className="text-ink font-bold">Sin fiados pendientes</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(c => (
              <div key={c.id} className={`bg-surface border rounded-2xl p-4 ${RISK_COLORS[c.risk_level] || ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-ink font-bold text-sm">{c.client_name}</div>
                    {c.client_phone && <div className="text-ink-3 text-xs mt-0.5">{c.client_phone}</div>}
                    {c.days_overdue > 0 && (
                      <div className="text-xs mt-1 text-warn">{c.days_overdue} día{c.days_overdue !== 1 ? 's' : ''} vencido</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-black text-lg tabular-nums text-ink">{COP(c.total_owed)}</div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => openAbonar(c)}
                    className="flex-1 h-9 bg-primary-soft hover:bg-primary-soft text-primary font-semibold text-xs rounded-lg flex items-center justify-center gap-1 transition-colors">
                    <span className="material-symbols-outlined text-[14px]">savings</span>
                    Abonar
                  </button>
                  <button onClick={() => openSaldar(c)}
                    className="flex-1 h-9 bg-success-soft hover:bg-success-soft text-success font-semibold text-xs rounded-lg flex items-center justify-center gap-1 transition-colors">
                    <span className="material-symbols-outlined text-[14px]">check_circle</span>
                    Saldar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        </>
        )}
      </div>

      {/* ── Modal abonar ── */}
      {selected && mode === 'abonar' && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-ink">Registrar abono</h2>
                <p className="text-ink-3 text-xs mt-0.5">{selected.client_name} · debe {COP(selected.total_owed)}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* Monto */}
            <div>
              <label className="block text-ink-3 text-[10px] font-bold uppercase tracking-widest mb-1.5">Monto del abono</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 font-bold">$</span>
                <input
                  type="text" inputMode="numeric" autoFocus
                  value={abonoAmount}
                  onChange={e => { setAbonoAmount(e.target.value); setAbonoError(''); }}
                  placeholder="0"
                  className="w-full bg-bg border border-line rounded-xl h-12 pl-7 pr-3 text-ink text-lg font-bold tabular-nums focus:border-primary transition-colors outline-none"
                />
              </div>
              {/* Accesos rápidos por porcentaje */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {([0.25, 0.5, 0.75, 1] as const).map(frac => {
                  const v = Math.round(selected.total_owed * frac);
                  return (
                    <button key={frac} type="button"
                      onClick={() => { setAbonoAmount(String(v)); setAbonoError(''); }}
                      className="px-2.5 py-1 bg-bg border border-line hover:border-primary text-ink-2 text-[11px] rounded-lg transition-colors">
                      {frac === 1 ? 'Todo' : `${frac * 100}%`} ({COP(v)})
                    </button>
                  );
                })}
              </div>
              {validAbono && abonoRemaining > 0.5 && (
                <p className="text-ink-3 text-xs mt-2">
                  Quedará pendiente: <span className="font-bold text-ink">{COP(abonoRemaining)}</span>
                </p>
              )}
              {abonoError && <p className="text-danger text-xs mt-2">{abonoError}</p>}
            </div>

            {/* Métodos de pago como botones */}
            <div>
              <label className="block text-ink-3 text-[10px] font-bold uppercase tracking-widest mb-1.5">Método de pago</label>
              <div className="space-y-2">
                {paymentOptions.map(pm => (
                  <button key={pm.id} type="button" onClick={() => setMethod(pm.name)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border text-left transition-all ${
                      method === pm.name
                        ? 'bg-primary-soft/40 border-primary/50 text-primary'
                        : 'bg-bg border-line text-ink-2 hover:border-line-strong'
                    }`}>
                    <span className={`material-symbols-outlined text-[18px] ${method === pm.name ? 'text-primary' : colorForType(pm.type)}`}>
                      {pm.icon || 'payments'}
                    </span>
                    <span className="font-medium text-sm flex-1">{pm.name}</span>
                    {method === pm.name && <span className="material-symbols-outlined text-primary text-[16px]">check_circle</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button onClick={handlePay} disabled={busy || !validAbono}
                className="h-12 bg-primary-soft/70 hover:bg-primary-soft disabled:opacity-40 disabled:cursor-not-allowed text-primary font-bold rounded-xl border border-primary/30 transition-colors flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[16px]">savings</span>
                {busy ? 'Guardando…' : 'Registrar abono'}
              </button>
              <button onClick={() => { setSelected(null); setAbonoError(''); }}
                className="h-12 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal saldar ── */}
      {selected && mode === 'saldar' && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-ink">¿Cómo pagó?</h2>
                <p className="text-ink-3 text-xs mt-0.5">{selected.client_name} · {COP(selected.total_owed)}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="bg-success-soft/20 border border-success/20 rounded-xl p-3 text-center">
              <div className="text-success font-bold text-sm">Pago completo</div>
              <div className="text-ink font-black text-2xl mt-1">{COP(selected.total_owed)}</div>
            </div>

            {/* Métodos de pago como botones */}
            <div className="space-y-2">
              {paymentOptions.map(pm => (
                <button key={pm.id} type="button" onClick={() => setMethod(pm.name)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                    method === pm.name
                      ? 'bg-primary-soft/40 border-primary/50 text-primary'
                      : 'bg-bg border-line text-ink-2 hover:border-line-strong'
                  }`}>
                  <span className={`material-symbols-outlined text-[20px] ${method === pm.name ? 'text-primary' : colorForType(pm.type)}`}>
                    {pm.icon || 'payments'}
                  </span>
                  <span className="font-medium text-sm flex-1">{pm.name}</span>
                  {method === pm.name && <span className="material-symbols-outlined text-primary text-[18px]">check_circle</span>}
                </button>
              ))}
            </div>

            {error && <div className="text-danger text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button onClick={handlePay} disabled={busy}
                className="h-12 bg-success-soft hover:bg-success-soft disabled:opacity-40 text-success font-bold rounded-xl transition-colors flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                {busy ? 'Guardando…' : 'Marcar pagado'}
              </button>
              <button onClick={() => { setSelected(null); setError(''); }}
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
