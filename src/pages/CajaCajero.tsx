import { useState, useEffect, useCallback } from 'react';
import { api, CashSession, CashMovement, CashMovementType, SupplierLite } from '../services/api';
import {
  ENTRY_MOTIVOS,
  EXIT_MOTIVOS,
  REASON_PRESETS,
  composeMovement,
  type EntryMotivo,
  type ExitMotivo,
} from '../lib/cash-motivos';

const COP = (n: number) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

const MOVEMENT_LABELS: Record<CashMovementType, string> = {
  sale:               'Venta',
  expense:            'Gasto',
  salary:             'Salario',
  inventory_purchase: 'Compra inventario',
  withdrawal:         'Retiro',
  deposit:            'Depósito',
  adjustment:         'Ajuste',
  advance:            'Vale empleado',
};

export default function CajaCajero() {
  const [session, setSession]     = useState<CashSession | null>(null);
  const [movements, setMovements] = useState<CashMovement[]>([]);
  // Efectivo esperado en el cajón = apertura + ventas en efectivo + entradas −
  // salidas. Lo calcula el backend (/pos/cash/current). Es lo que el cajero debe
  // entregar al cerrar.
  const [expected, setExpected]   = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  // Apertura
  const [showOpen, setShowOpen]     = useState(false);
  const [openAmount, setOpenAmount] = useState('');
  const [openNotes, setOpenNotes]   = useState('');
  const [openBusy, setOpenBusy]     = useState(false);

  // Cierre
  const [showClose, setShowClose]     = useState(false);
  const [closeAmount, setCloseAmount] = useState('');
  const [closeNotes, setCloseNotes]   = useState('');
  const [closeBusy, setCloseBusy]     = useState(false);

  // Movimiento
  const [showMove, setShowMove]         = useState(false);
  const [movDirection, setMovDirection] = useState<'out' | 'in'>('out');
  const [motivo, setMotivo]             = useState<EntryMotivo | ExitMotivo>(EXIT_MOTIVOS[0].value);
  const [moveAmount, setMoveAmount]     = useState('');
  const [moveReason, setMoveReason]     = useState('');
  const [moveBusy, setMoveBusy]         = useState(false);

  // Proveedor — solo para el motivo "Pago a proveedor". Se elige de la lista
  // activa de la org (/pos/suppliers); si no está, el cajero lo deja en la nota.
  const [suppliers, setSuppliers]             = useState<SupplierLite[]>([]);
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierLite | null>(null);
  const [supplierQuery, setSupplierQuery]     = useState('');

  const resetMovementFields = () => {
    setMoveReason('');
    setSelectedSupplier(null);
    setSupplierQuery('');
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.cash.current();
      setSession(d.session);
      setMovements(d.movements || []);
      setExpected(typeof d.expected === 'number' ? d.expected : 0);
    } catch { setError('No se pudo cargar la caja'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showOk = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  const handleOpen = async () => {
    const amt = parseFloat(openAmount) || 0;
    setOpenBusy(true); setError('');
    try {
      await api.cash.open(amt, openNotes || undefined);
      setShowOpen(false); setOpenAmount(''); setOpenNotes('');
      showOk('Caja abierta');
      // El POS vive en otra pestaña y queda siempre montado: avisarle para que
      // re-evalúe la caja al instante y desbloquee la venta sin esperar el
      // refresco periódico ni un toque manual.
      window.dispatchEvent(new CustomEvent('pos:cash-changed'));
      load();
    } catch (e: any) { setError(e.message || 'Error al abrir'); }
    finally { setOpenBusy(false); }
  };

  const handleClose = async () => {
    const amt = parseFloat(closeAmount);
    if (isNaN(amt)) { setError('Ingresa el monto contado'); return; }
    setCloseBusy(true); setError('');
    try {
      await api.cash.close(amt, closeNotes || undefined);
      setShowClose(false); setCloseAmount(''); setCloseNotes('');
      showOk('Caja cerrada');
      window.dispatchEvent(new CustomEvent('pos:cash-changed'));
      load();
    } catch (e: any) { setError(e.message || 'Error al cerrar'); }
    finally { setCloseBusy(false); }
  };

  const handleDirection = (dir: 'out' | 'in') => {
    setMovDirection(dir);
    setMotivo(dir === 'out' ? EXIT_MOTIVOS[0].value : ENTRY_MOTIVOS[0].value);
    resetMovementFields();
  };

  // Carga perezosa de proveedores la primera vez que el cajero elige "Pago a
  // proveedor". Si falla, degradamos a nota libre sin romper el flujo.
  useEffect(() => {
    if (motivo !== 'pago_proveedor' || suppliers.length > 0 || supplierLoading) return;
    setSupplierLoading(true);
    api.suppliers.list()
      .then(d => setSuppliers(d.suppliers || []))
      .catch(() => setSuppliers([]))
      .finally(() => setSupplierLoading(false));
  }, [motivo, suppliers.length, supplierLoading]);

  const handleMove = async () => {
    const amt = parseFloat(moveAmount);
    if (!amt || amt <= 0) { setError('Ingresa un monto válido'); return; }
    // El motivo ya define el tipo; solo "Otro" exige una descripción escrita.
    if (motivo === 'otro' && !moveReason.trim()) { setError('Describe el motivo'); return; }
    const { type, reason } = composeMovement(movDirection, motivo, moveReason, selectedSupplier?.name);
    setMoveBusy(true); setError('');
    try {
      await api.cash.addMovement(type, amt, reason, selectedSupplier?.id ?? null);
      setShowMove(false); setMoveAmount(''); resetMovementFields();
      showOk('Movimiento registrado');
      load();
    } catch (e: any) { setError(e.message || 'Error al registrar'); }
    finally { setMoveBusy(false); }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-[#8a9295]">
        <span className="material-symbols-outlined text-3xl animate-spin">progress_activity</span>
      </div>
    );
  }

  const isOpen = session?.status === 'open';
  const motivosForDir = movDirection === 'out' ? EXIT_MOTIVOS : ENTRY_MOTIVOS;
  const reasonPresets = REASON_PRESETS[motivo] || [];

  const supplierQ = supplierQuery.trim().toLowerCase();
  const filteredSuppliers = supplierQ
    ? suppliers.filter(s =>
        s.name.toLowerCase().includes(supplierQ)
        || (s.company || '').toLowerCase().includes(supplierQ))
    : suppliers;

  const totalMov = movements
    .filter(m => m.type !== 'sale')
    .reduce((acc, m) => m.type === 'deposit' || m.type === 'adjustment' ? acc + Number(m.amount) : acc - Number(m.amount), 0);

  // Ventas en efectivo del turno (las que ya están contadas dentro de `expected`).
  const cashSales = movements
    .filter(m => m.type === 'sale')
    .reduce((acc, m) => acc + Number(m.amount), 0);

  // Cuadre en vivo del cierre: contado − esperado. >0 sobra, <0 falta.
  const countedNum = closeAmount.trim() !== '' ? (parseFloat(closeAmount) || 0) : null;
  const closeDiff  = countedNum != null ? countedNum - expected : null;

  return (
    <div className="h-full overflow-y-auto bg-[#111415]">
      <div className="max-w-lg mx-auto px-4 py-5 pb-6 space-y-4">

        {success && <div className="px-4 py-2.5 bg-[#12533a] border border-[#95d4b3]/40 text-[#95d4b3] rounded-xl text-sm font-semibold">✓ {success}</div>}
        {error   && <div className="px-4 py-2.5 bg-[#93000a]/30 border border-[#93000a] text-[#ffb4ab] rounded-xl text-sm">{error}</div>}

        {/* Status card */}
        <div className={`rounded-2xl p-5 border ${isOpen ? 'bg-[#12533a]/20 border-[#95d4b3]/30' : 'bg-[#1E1E1E] border-[#2a2a2a]'}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[#8a9295] text-[11px] uppercase tracking-wider font-bold mb-1">Estado</div>
              <div className={`font-black text-2xl ${isOpen ? 'text-[#95d4b3]' : 'text-[#8a9295]'}`}>
                {isOpen ? 'Abierta' : 'Cerrada'}
              </div>
              {isOpen && session && (
                <div className="text-[#8a9295] text-xs mt-1">
                  Desde {new Date(session.opened_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
            <span className={`material-symbols-outlined text-5xl ${isOpen ? 'text-[#95d4b3]' : 'text-[#40484b]'}`}>
              account_balance_wallet
            </span>
          </div>

          {isOpen && (
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="bg-[#121212] rounded-xl p-3">
                <div className="text-[#8a9295] text-[10px] uppercase tracking-wider mb-0.5">Apertura</div>
                <div className="text-[#e1e2e4] font-bold tabular-nums">{COP(session?.opening_amount || 0)}</div>
              </div>
              <div className="bg-[#121212] rounded-xl p-3">
                <div className="text-[#8a9295] text-[10px] uppercase tracking-wider mb-0.5">Ventas efectivo</div>
                <div className="text-[#95d4b3] font-bold tabular-nums">{COP(cashSales)}</div>
              </div>
              <div className="bg-[#121212] rounded-xl p-3">
                <div className="text-[#8a9295] text-[10px] uppercase tracking-wider mb-0.5">Movimientos</div>
                <div className={`font-bold tabular-nums ${totalMov >= 0 ? 'text-[#95d4b3]' : 'text-[#ffb4ab]'}`}>{COP(totalMov)}</div>
              </div>
            </div>
          )}
          {isOpen && (
            <div className="mt-3 bg-[#12533a]/30 border border-[#95d4b3]/40 rounded-xl p-3.5 flex items-center justify-between">
              <div>
                <div className="text-[#95d4b3] text-[10px] uppercase tracking-wider font-bold mb-0.5">Efectivo esperado en caja</div>
                <div className="text-[#8a9295] text-[11px]">Esto es lo que debe haber para entregar</div>
              </div>
              <div className="text-[#95d4b3] font-black text-2xl tabular-nums">{COP(expected)}</div>
            </div>
          )}
        </div>

        {/* Actions */}
        {!isOpen ? (
          <button onClick={() => setShowOpen(true)}
            className="w-full h-14 bg-[#12533a] hover:bg-[#1a6b45] text-[#95d4b3] font-bold rounded-2xl flex items-center justify-center gap-2 text-base transition-colors active:scale-[0.98]">
            <span className="material-symbols-outlined">lock_open</span>
            Abrir caja
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => { setShowMove(true); handleDirection('out'); }}
              className="h-12 bg-[#0f4c5c] hover:bg-[#155a6d] text-[#9acee1] font-bold rounded-xl flex items-center justify-center gap-1.5 text-sm transition-colors active:scale-[0.98]">
              <span className="material-symbols-outlined text-[18px]">swap_horiz</span>
              Movimiento
            </button>
            <button onClick={() => setShowClose(true)}
              className="h-12 bg-[#3a1010] hover:bg-[#5a1818] text-[#ffb4ab] font-bold rounded-xl flex items-center justify-center gap-1.5 text-sm transition-colors active:scale-[0.98]">
              <span className="material-symbols-outlined text-[18px]">lock</span>
              Cerrar caja
            </button>
          </div>
        )}

        {/* Movements list */}
        {movements.length > 0 && (
          <div>
            <div className="text-[#8a9295] text-[10px] uppercase tracking-wider font-bold mb-2">Movimientos del turno</div>
            <div className="space-y-1.5">
              {movements.slice(0, 30).map(m => (
                <div key={m.id} className="bg-[#1E1E1E] border border-[#2a2a2a] rounded-xl px-3 py-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-[#e1e2e4] text-sm font-semibold">{MOVEMENT_LABELS[m.type] || m.type}</div>
                    <div className="text-[#8a9295] text-xs truncate max-w-[200px]">{m.reason}</div>
                  </div>
                  <div className={`font-bold tabular-nums text-sm shrink-0 ${
                    m.type === 'sale' || m.type === 'deposit' || m.type === 'adjustment'
                      ? 'text-[#95d4b3]' : 'text-[#ffb4ab]'
                  }`}>
                    {m.type === 'sale' || m.type === 'deposit' || m.type === 'adjustment' ? '+' : '-'}{COP(m.amount)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Modal: abrir caja ── */}
      {showOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[#1E1E1E] border border-[#333] rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[#e1e2e4] text-lg">Abrir caja</h2>
              <button onClick={() => { setShowOpen(false); setError(''); }} className="text-[#8a9295] hover:text-[#e1e2e4]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Efectivo inicial</label>
              <input type="number" value={openAmount} onChange={e => setOpenAmount(e.target.value)} placeholder="0" autoFocus
                className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
            </div>
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Notas (opcional)</label>
              <input type="text" value={openNotes} onChange={e => setOpenNotes(e.target.value)} placeholder="Observaciones…"
                className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
            </div>
            {error && <div className="text-[#ffb4ab] text-sm">{error}</div>}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleOpen} disabled={openBusy}
                className="h-11 bg-[#12533a] hover:bg-[#1a6b45] disabled:opacity-40 text-[#95d4b3] font-bold rounded-xl transition-colors">
                {openBusy ? 'Abriendo…' : 'Abrir caja'}
              </button>
              <button onClick={() => { setShowOpen(false); setError(''); }}
                className="h-11 bg-[#1d2021] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl hover:bg-[#282a2b] transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: cerrar caja ── */}
      {showClose && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[#1E1E1E] border border-[#333] rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[#e1e2e4] text-lg">Cerrar caja</h2>
              <button onClick={() => { setShowClose(false); setError(''); }} className="text-[#8a9295] hover:text-[#e1e2e4]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="bg-[#121212] border border-[#333] rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[#8a9295] text-[10px] uppercase tracking-wider">Apertura</div>
                  <div className="text-[#e1e2e4] font-bold tabular-nums">{COP(session?.opening_amount || 0)}</div>
                </div>
                <div className="text-center">
                  <div className="text-[#8a9295] text-[10px] uppercase tracking-wider">Ventas efectivo</div>
                  <div className="text-[#95d4b3] font-bold tabular-nums">{COP(cashSales)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[#8a9295] text-[10px] uppercase tracking-wider">Movimientos</div>
                  <div className={`font-bold tabular-nums ${totalMov >= 0 ? 'text-[#95d4b3]' : 'text-[#ffb4ab]'}`}>{COP(totalMov)}</div>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-[#333] pt-3">
                <div className="text-[#95d4b3] text-[11px] uppercase tracking-wider font-bold">Efectivo esperado</div>
                <div className="text-[#95d4b3] font-black text-lg tabular-nums">{COP(expected)}</div>
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Efectivo contado</label>
              <input type="number" value={closeAmount} onChange={e => setCloseAmount(e.target.value)} placeholder="0" autoFocus
                className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
            </div>
            {closeDiff != null && (
              <div className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-bold ${
                closeDiff === 0
                  ? 'bg-[#12533a]/30 border border-[#95d4b3]/40 text-[#95d4b3]'
                  : closeDiff > 0
                    ? 'bg-[#0f4c5c]/30 border border-[#9acee1]/40 text-[#9acee1]'
                    : 'bg-[#3a1010] border border-[#5a1818] text-[#ffb4ab]'
              }`}>
                <span>{closeDiff === 0 ? 'Caja cuadrada' : closeDiff > 0 ? 'Sobrante' : 'Faltante'}</span>
                <span className="tabular-nums">{COP(Math.abs(closeDiff))}</span>
              </div>
            )}
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Notas (opcional)</label>
              <input type="text" value={closeNotes} onChange={e => setCloseNotes(e.target.value)} placeholder="Observaciones al cierre…"
                className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
            </div>
            {error && <div className="text-[#ffb4ab] text-sm">{error}</div>}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleClose} disabled={closeBusy}
                className="h-11 bg-[#93000a] hover:bg-[#b00010] disabled:opacity-40 text-[#ffdad6] font-bold rounded-xl transition-colors">
                {closeBusy ? 'Cerrando…' : 'Cerrar caja'}
              </button>
              <button onClick={() => { setShowClose(false); setError(''); }}
                className="h-11 bg-[#1d2021] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl hover:bg-[#282a2b] transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: movimiento ── */}
      {showMove && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[#1E1E1E] border border-[#333] rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[#e1e2e4] text-lg">Movimiento de caja</h2>
              <button onClick={() => { setShowMove(false); setError(''); }} className="text-[#8a9295] hover:text-[#e1e2e4]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* Toggle entrada / salida */}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => handleDirection('out')}
                className={`h-10 rounded-xl font-bold text-sm transition-colors ${
                  movDirection === 'out'
                    ? 'bg-[#93000a]/30 border border-[#ffb4ab] text-[#ffb4ab]'
                    : 'bg-[#1d2021] border border-[#333] text-[#8a9295]'
                }`}>
                ↓ Sale dinero
              </button>
              <button onClick={() => handleDirection('in')}
                className={`h-10 rounded-xl font-bold text-sm transition-colors ${
                  movDirection === 'in'
                    ? 'bg-[#12533a]/40 border border-[#95d4b3] text-[#95d4b3]'
                    : 'bg-[#1d2021] border border-[#333] text-[#8a9295]'
                }`}>
                ↑ Entra dinero
              </button>
            </div>

            {/* Motivo */}
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Motivo</label>
              <div className="grid grid-cols-2 gap-2">
                {motivosForDir.map(opt => (
                  <button key={opt.value} type="button"
                    onClick={() => { setMotivo(opt.value); resetMovementFields(); }}
                    className={`px-3 py-2 rounded-xl text-sm font-semibold border transition-colors text-left ${
                      motivo === opt.value
                        ? 'bg-[#0f4c5c]/30 border-[#9acee1] text-[#9acee1]'
                        : 'bg-[#121212] border-[#2a2a2a] text-[#8a9295] hover:text-[#c0c8cb] hover:border-[#444]'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Proveedor — solo en "Pago a proveedor". Buscar y elegir uno activo;
                si no aparece, el cajero lo deja en la nota. */}
            {motivo === 'pago_proveedor' && (
              <div>
                <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Proveedor</label>
                {selectedSupplier ? (
                  <div className="flex items-center justify-between bg-[#0f4c5c]/30 border border-[#9acee1]/40 rounded-xl px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[#9acee1] text-sm font-semibold truncate">{selectedSupplier.name}</div>
                      {selectedSupplier.company && (
                        <div className="text-[#8a9295] text-xs truncate">{selectedSupplier.company}</div>
                      )}
                    </div>
                    <button type="button" onClick={() => { setSelectedSupplier(null); setSupplierQuery(''); }}
                      className="text-[#8a9295] text-xs font-semibold hover:text-[#e1e2e4] shrink-0 ml-2">
                      Cambiar
                    </button>
                  </div>
                ) : (
                  <>
                    <input type="text" value={supplierQuery} onChange={e => setSupplierQuery(e.target.value)}
                      placeholder="Buscar proveedor…"
                      className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
                    {supplierLoading ? (
                      <div className="text-[#8a9295] text-xs mt-1.5">Cargando proveedores…</div>
                    ) : suppliers.length === 0 ? (
                      <div className="text-[#8a9295] text-xs mt-1.5">No hay proveedores registrados. Escribe el nombre en la nota.</div>
                    ) : filteredSuppliers.length > 0 ? (
                      <div className="mt-1.5 max-h-40 overflow-y-auto rounded-xl border border-[#2a2a2a] divide-y divide-[#2a2a2a]">
                        {filteredSuppliers.slice(0, 8).map(s => (
                          <button key={s.id} type="button" onClick={() => { setSelectedSupplier(s); setSupplierQuery(''); }}
                            className="w-full text-left px-4 py-2.5 bg-[#1E1E1E] hover:bg-[#282a2b] transition-colors">
                            <div className="text-[#e1e2e4] text-sm font-medium truncate">{s.name}</div>
                            {s.company && <div className="text-[#8a9295] text-xs truncate">{s.company}</div>}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[#8a9295] text-xs mt-1.5">Sin coincidencias. Escribe el nombre en la nota.</div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Monto */}
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">Monto</label>
              <input type="number" value={moveAmount} onChange={e => setMoveAmount(e.target.value)} placeholder="0"
                className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
            </div>

            {/* Nota con presets rápidos */}
            <div>
              <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">
                {motivo === 'otro' ? 'Descripción' : 'Nota (opcional)'}
              </label>
              {reasonPresets.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {reasonPresets.map(r => (
                    <button key={r} type="button" onClick={() => setMoveReason(r)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                        moveReason === r
                          ? 'bg-[#0f4c5c]/30 border-[#9acee1]/40 text-[#9acee1]'
                          : 'bg-[#121212] border-[#2a2a2a] text-[#8a9295] hover:text-[#c0c8cb] hover:border-[#444]'
                      }`}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
              <input type="text" value={moveReason} onChange={e => setMoveReason(e.target.value)}
                placeholder={motivo === 'otro' ? 'Describe el motivo…' : 'Detalle adicional…'}
                className="w-full bg-[#121212] border border-[#333] rounded-xl px-4 py-2.5 text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none transition-colors" />
            </div>

            {error && <div className="text-[#ffb4ab] text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleMove} disabled={moveBusy}
                className="h-11 bg-[#0f4c5c] hover:bg-[#155a6d] disabled:opacity-40 text-[#9acee1] font-bold rounded-xl transition-colors">
                {moveBusy ? 'Guardando…' : 'Registrar'}
              </button>
              <button onClick={() => { setShowMove(false); setError(''); }}
                className="h-11 bg-[#1d2021] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl hover:bg-[#282a2b] transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
