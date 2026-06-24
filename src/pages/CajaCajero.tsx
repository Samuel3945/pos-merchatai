import { useState, useEffect, useCallback } from 'react';
import { api, CashSession, CashMovement, CashMovementType, SupplierLite, SupplierOutstanding, MovementOutcome } from '../services/api';
import {
  ENTRY_MOTIVOS,
  EXIT_MOTIVOS,
  REASON_PRESETS,
  composeMovement,
  type EntryMotivo,
  type ExitMotivo,
} from '../lib/cash-motivos';

const COP = (n: number) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

// Revela el cuadre DESPUÉS de confirmar el conteo a ciegas: >0 sobra, <0 falta.
function DiffBanner({ diff, zeroLabel }: { diff: number; zeroLabel: string }) {
  const tone = diff === 0
    ? 'bg-success-soft/30 border border-success/40 text-success'
    : diff > 0
      ? 'bg-primary-soft/30 border border-primary/40 text-primary'
      : 'bg-danger-soft border border-danger text-danger';
  const label = diff === 0 ? zeroLabel : diff > 0 ? 'Sobrante' : 'Faltante';
  return (
    <div className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-bold ${tone}`}>
      <span>{label}</span>
      <span className="tabular-nums">{COP(Math.abs(diff))}</span>
    </div>
  );
}

const MOVEMENT_LABELS: Record<CashMovementType, string> = {
  sale:               'Venta',
  expense:            'Gasto',
  salary:             'Salario',
  inventory_purchase: 'Compra inventario',
  withdrawal:         'Retiro',
  deposit:            'Depósito',
  adjustment:         'Ajuste',
  advance:            'Vale empleado',
  credito_payment:      'Cobro de crédito',
  reclassification:   'Reclasificación',
};

// Cash inflows (added to the drawer). Everything else is an outflow. Mirrors the
// backend direction map (MerchantAI features/cash/cash-ui.ts TYPE_META) so a
// credito payment shows as a positive entry here just like in the admin panel.
const INFLOW_TYPES = new Set<CashMovementType>([
  'sale', 'deposit', 'adjustment', 'credito_payment', 'reclassification',
]);

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
  const [openBusy, setOpenBusy]     = useState(false);
  const [openExplanation, setOpenExplanation] = useState('');
  // Carry-over: lo que el cajón debe tener al abrir = último cierre contado. El
  // backend lo manda en /current cuando no hay sesión abierta (0 si no hay
  // cierre previo). NO se lo mostramos al cajero (conteo a ciegas); solo lo
  // usamos para revelar la diferencia DESPUÉS de que confirme.
  const [expectedOpening, setExpectedOpening] = useState(0);
  // Conteo a ciegas: tras confirmar la apertura, revelamos aquí la diferencia
  // (contado − esperado del carry-over). diff=null cuando no hay cierre previo.
  const [openResult, setOpenResult] = useState<{ counted: number; diff: number | null } | null>(null);

  // Cierre
  const [showClose, setShowClose]     = useState(false);
  const [closeAmount, setCloseAmount] = useState('');
  const [closeNotes, setCloseNotes]   = useState('');
  const [closeBusy, setCloseBusy]     = useState(false);
  // Conteo a ciegas: tras confirmar el cierre, revelamos aquí la diferencia
  // (contado − esperado).
  const [closeResult, setCloseResult] = useState<{ counted: number; diff: number } | null>(null);

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
  // Deuda pendiente del proveedor seleccionado. Se carga al elegir un proveedor
  // y se muestra como contexto antes de confirmar el pago. null = no cargado o
  // el fetch falló (degradamos sin bloquear el flujo).
  const [supplierOutstanding, setSupplierOutstanding] = useState<SupplierOutstanding | null>(null);
  const [outstandingLoading, setOutstandingLoading] = useState(false);
  // Resultado del último movimiento de "Pago a proveedor": indica si se saldaron
  // facturas o si se registró como gasto sin facturas pendientes.
  const [moveOutcome, setMoveOutcome] = useState<MovementOutcome | null>(null);

  const resetMovementFields = () => {
    setMoveReason('');
    setSelectedSupplier(null);
    setSupplierQuery('');
    setSupplierOutstanding(null);
    setMoveOutcome(null);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.cash.current();
      setSession(d.session);
      setMovements(d.movements || []);
      setExpected(typeof d.expected === 'number' ? d.expected : 0);
      setExpectedOpening(typeof d.expected_opening === 'number' ? d.expected_opening : 0);
    } catch { setError('No se pudo cargar la caja'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showOk = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  const handleOpen = async () => {
    const amt = parseFloat(openAmount) || 0;
    // Abrir NUNCA se bloquea: el backend barre el faltante solo (ADR-2). Si hay
    // diferencia la explicación es opcional y el backend la guarda si se escribe.
    setOpenBusy(true); setError('');
    try {
      await api.cash.open(amt, undefined, openExplanation.trim() || undefined);
      // Conteo a ciegas: capturamos la diferencia ANTES de load() (que resetea
      // expectedOpening) y la revelamos recién ahora que el cajero ya confirmó.
      const diff = expectedOpening > 0 ? amt - expectedOpening : null;
      setOpenResult({ counted: amt, diff });
      setOpenAmount(''); setOpenExplanation('');
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
      await api.cash.close(amt, closeNotes.trim() || undefined);
      // Conteo a ciegas: capturamos la diferencia ANTES de load() (que resetea
      // expected) y la revelamos recién ahora que el cajero ya confirmó.
      setCloseResult({ counted: amt, diff: amt - expected });
      setCloseAmount(''); setCloseNotes('');
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

  // Al seleccionar un proveedor, traemos su deuda pendiente. Si el fetch falla,
  // simplemente dejamos supplierOutstanding en null y el cajero puede seguir.
  useEffect(() => {
    if (!selectedSupplier) { setSupplierOutstanding(null); return; }
    let active = true;
    setOutstandingLoading(true);
    api.suppliers.outstanding(selectedSupplier.id)
      .then(data => { if (active) setSupplierOutstanding(data); })
      .catch(() => { if (active) setSupplierOutstanding(null); })
      .finally(() => { if (active) setOutstandingLoading(false); });
    return () => { active = false; };
  }, [selectedSupplier]);

  const handleMove = async () => {
    const amt = parseFloat(moveAmount);
    if (!amt || amt <= 0) { setError('Ingresa un monto válido'); return; }
    // Block overpay on the settle path: the backend will reject it with 400 anyway,
    // but we stop it client-side first to give a clearer inline message.
    if (
      motivo === 'pago_proveedor' &&
      supplierOutstanding !== null &&
      parseFloat(supplierOutstanding.totalOutstanding) > 0 &&
      amt > parseFloat(supplierOutstanding.totalOutstanding)
    ) {
      setError(`El monto supera la deuda del proveedor (${COP(parseFloat(supplierOutstanding.totalOutstanding))}). Reducí el monto o registralo como gasto aparte.`);
      return;
    }
    // El motivo ya define el tipo; solo "Otro" exige una descripción escrita.
    if (motivo === 'otro' && !moveReason.trim()) { setError('Describe el motivo'); return; }
    const { type, reason } = composeMovement(movDirection, motivo, moveReason, selectedSupplier?.name);
    setMoveBusy(true); setError('');
    try {
      const result = await api.cash.addMovement(type, amt, reason, selectedSupplier?.id ?? null);
      // Capturamos el outcome antes de limpiar el estado para mostrarlo en el
      // banner de confirmación. Solo aplica para "Pago a proveedor".
      if (motivo === 'pago_proveedor' && result.outcome) {
        setMoveOutcome({ outcome: result.outcome, appliedTotal: result.appliedTotal, settledPayables: result.settledPayables });
      } else {
        setShowMove(false); setMoveAmount(''); resetMovementFields();
        showOk('Movimiento registrado');
      }
      load();
    } catch (e: any) { setError(e.message || 'Error al registrar'); }
    finally { setMoveBusy(false); }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-ink-3">
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
    .reduce((acc, m) => INFLOW_TYPES.has(m.type) ? acc + Number(m.amount) : acc - Number(m.amount), 0);

  // Ventas en efectivo del turno (las que ya están contadas dentro de `expected`).
  const cashSales = movements
    .filter(m => m.type === 'sale')
    .reduce((acc, m) => acc + Number(m.amount), 0);

  // Conteo a ciegas: NO calculamos ni mostramos diferencias mientras el cajero
  // tipea. La diferencia se revela solo después de confirmar (openResult /
  // closeResult), para que no pueda ajustar el conteo hasta que "cuadre".

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-6 space-y-4">

        {success && <div className="px-4 py-2.5 bg-success-soft border border-success/40 text-success rounded-xl text-sm font-semibold">✓ {success}</div>}
        {error   && <div className="px-4 py-2.5 bg-danger-soft/30 border border-danger text-danger rounded-xl text-sm">{error}</div>}

        {/* Status card */}
        <div className={`rounded-2xl p-5 border ${isOpen ? 'bg-success-soft/20 border-success/30' : 'bg-surface border-line'}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-1">Estado</div>
              <div className={`font-black text-2xl ${isOpen ? 'text-success' : 'text-ink-3'}`}>
                {isOpen ? 'Abierta' : 'Cerrada'}
              </div>
              {isOpen && session && (
                <div className="text-ink-3 text-xs mt-1">
                  Desde {new Date(session.opened_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
            <span className={`material-symbols-outlined text-5xl ${isOpen ? 'text-success' : 'text-ink-4'}`}>
              account_balance_wallet
            </span>
          </div>

          {isOpen && (
            // Montos con blur permanente: estos tres sumados delatan el esperado,
            // así que se ven los rubros pero no los números (conteo a ciegas).
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="bg-bg border border-line rounded-xl p-3">
                <div className="text-ink-3 text-[10px] uppercase tracking-wider mb-0.5">Apertura</div>
                <div className="text-ink font-bold tabular-nums blur-sm select-none">{COP(session?.opening_amount || 0)}</div>
              </div>
              <div className="bg-bg border border-line rounded-xl p-3">
                <div className="text-ink-3 text-[10px] uppercase tracking-wider mb-0.5">Ventas efectivo</div>
                <div className="text-success font-bold tabular-nums blur-sm select-none">{COP(cashSales)}</div>
              </div>
              <div className="bg-bg border border-line rounded-xl p-3">
                <div className="text-ink-3 text-[10px] uppercase tracking-wider mb-0.5">Movimientos</div>
                <div className={`font-bold tabular-nums blur-sm select-none ${totalMov >= 0 ? 'text-success' : 'text-danger'}`}>{COP(totalMov)}</div>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        {!isOpen ? (
          <button onClick={() => { setOpenResult(null); setError(''); setShowOpen(true); }}
            className="w-full h-14 bg-primary hover:bg-primary-ink text-white font-bold rounded-2xl flex items-center justify-center gap-2 text-base transition-colors active:scale-[0.98]">
            <span className="material-symbols-outlined">lock_open</span>
            Abrir caja
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => { setShowMove(true); handleDirection('out'); }}
              className="h-12 bg-primary hover:bg-primary-ink text-white font-bold rounded-xl flex items-center justify-center gap-1.5 text-sm transition-colors active:scale-[0.98]">
              <span className="material-symbols-outlined text-[18px]">swap_horiz</span>
              Movimiento
            </button>
            <button onClick={() => { setCloseResult(null); setError(''); setShowClose(true); }}
              className="h-12 bg-surface border border-line-strong text-ink font-bold rounded-xl flex items-center justify-center gap-1.5 text-sm transition-colors hover:border-danger hover:text-danger active:scale-[0.98]">
              <span className="material-symbols-outlined text-[18px]">lock</span>
              Cerrar caja
            </button>
          </div>
        )}

        {/* Movements list */}
        {movements.length > 0 && (
          <div>
            <div className="text-ink-3 text-[10px] uppercase tracking-wider font-bold mb-2">Movimientos del turno</div>
            <div className="space-y-1.5">
              {movements.slice(0, 30).map(m => (
                <div key={m.id} className="bg-surface border border-line rounded-xl px-3 py-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-ink text-sm font-semibold">{MOVEMENT_LABELS[m.type] || m.type}</div>
                    <div className="text-ink-3 text-xs truncate max-w-[200px]">{m.reason}</div>
                  </div>
                  <div className={`font-bold tabular-nums text-sm shrink-0 ${
                    INFLOW_TYPES.has(m.type) ? 'text-success' : 'text-danger'
                  }`}>
                    {INFLOW_TYPES.has(m.type) ? '+' : '-'}{COP(m.amount)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Modal: abrir caja (conteo a ciegas) ── */}
      {showOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink text-lg">Abrir caja</h2>
              <button onClick={() => { setShowOpen(false); setOpenResult(null); setError(''); }} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {openResult ? (
              /* Revelado: el cajero ya confirmó, ahora sí le mostramos el cuadre. */
              <>
                <div className="bg-bg border border-line rounded-xl p-4 text-center space-y-1">
                  <div className="text-ink-3 text-[10px] uppercase tracking-wider font-bold">Contaste</div>
                  <div className="text-ink font-black text-2xl tabular-nums">{COP(openResult.counted)}</div>
                </div>
                {openResult.diff == null ? (
                  <div className="flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold bg-success-soft/30 border border-success/40 text-success">
                    Caja abierta
                  </div>
                ) : (
                  <DiffBanner diff={openResult.diff} zeroLabel="Coincide con el cierre" />
                )}
                <button onClick={() => { setShowOpen(false); setOpenResult(null); }}
                  className="w-full h-11 bg-success-soft hover:bg-success-soft text-success font-bold rounded-xl transition-colors">
                  Listo
                </button>
              </>
            ) : (
              <>
                <div className="bg-surface-2 border border-line rounded-xl p-3 flex items-start gap-2">
                  <span className="material-symbols-outlined text-ink-3 text-[18px]">visibility_off</span>
                  <div className="text-ink-3 text-xs">Contá el efectivo del cajón y escribí el total. Te decimos si cuadra después de confirmar.</div>
                </div>
                <div>
                  <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">
                    {expectedOpening > 0 ? 'Efectivo contado' : 'Efectivo inicial'}
                  </label>
                  <input type="number" value={openAmount} onChange={e => setOpenAmount(e.target.value)} placeholder="0" autoFocus
                    className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Notas (opcional)</label>
                  <input type="text" value={openExplanation} onChange={e => setOpenExplanation(e.target.value)} placeholder="Si algo no cuadra, anotalo…"
                    className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
                </div>
                {error && <div className="text-danger text-sm">{error}</div>}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={handleOpen} disabled={openBusy}
                    className="h-11 bg-success-soft hover:bg-success-soft disabled:opacity-40 text-success font-bold rounded-xl transition-colors">
                    {openBusy ? 'Abriendo…' : 'Abrir caja'}
                  </button>
                  <button onClick={() => { setShowOpen(false); setError(''); }}
                    className="h-11 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                    Cancelar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: cerrar caja (conteo a ciegas) ── */}
      {showClose && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink text-lg">Cerrar caja</h2>
              <button onClick={() => { setShowClose(false); setCloseResult(null); setError(''); }} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {closeResult ? (
              /* Revelado: el cajero ya confirmó, ahora sí le decimos si falta o sobra. */
              <>
                <div className="bg-bg border border-line rounded-xl p-4 text-center space-y-1">
                  <div className="text-ink-3 text-[10px] uppercase tracking-wider font-bold">Contaste</div>
                  <div className="text-ink font-black text-2xl tabular-nums">{COP(closeResult.counted)}</div>
                </div>
                <DiffBanner diff={closeResult.diff} zeroLabel="Caja cuadrada" />
                <button onClick={() => { setShowClose(false); setCloseResult(null); }}
                  className="w-full h-11 bg-success-soft hover:bg-success-soft text-success font-bold rounded-xl transition-colors">
                  Listo
                </button>
              </>
            ) : (
              <>
                <div className="bg-surface-2 border border-line rounded-xl p-3 flex items-start gap-2">
                  <span className="material-symbols-outlined text-ink-3 text-[18px]">visibility_off</span>
                  <div className="text-ink-3 text-xs">Contá el efectivo del cajón y escribí el total. Te decimos si falta o sobra después de confirmar.</div>
                </div>
                <div>
                  <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Efectivo contado</label>
                  <input type="number" value={closeAmount} onChange={e => setCloseAmount(e.target.value)} placeholder="0" autoFocus
                    className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
                </div>
                <div>
                  <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Notas (opcional)</label>
                  <input type="text" value={closeNotes} onChange={e => setCloseNotes(e.target.value)} placeholder="Observaciones al cierre…"
                    className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
                </div>
                {error && <div className="text-danger text-sm">{error}</div>}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={handleClose} disabled={closeBusy}
                    className="h-11 bg-danger-soft hover:bg-danger disabled:opacity-40 text-danger font-bold rounded-xl transition-colors">
                    {closeBusy ? 'Cerrando…' : 'Cerrar caja'}
                  </button>
                  <button onClick={() => { setShowClose(false); setError(''); }}
                    className="h-11 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                    Cancelar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: movimiento ── */}
      {showMove && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink text-lg">Movimiento de caja</h2>
              <button onClick={() => { setShowMove(false); resetMovementFields(); setError(''); }} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* Confirmación de pago a proveedor: muestra si se saldaron facturas
                o si el pago se registró como gasto (sin facturas pendientes). */}
            {moveOutcome ? (
              <>
                {moveOutcome.outcome === 'settled' ? (
                  <div className="bg-success-soft/20 border border-success/40 rounded-xl px-4 py-3 space-y-1">
                    <div className="text-success font-bold text-sm">
                      Facturas saldadas — {COP(parseFloat(moveOutcome.appliedTotal || '0'))}
                    </div>
                    {(moveOutcome.settledPayables ?? 0) > 0 && (
                      <div className="text-ink-3 text-xs">
                        {moveOutcome.settledPayables} factura{moveOutcome.settledPayables !== 1 ? 's' : ''} cerrada{moveOutcome.settledPayables !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-surface-2 border border-line rounded-xl px-4 py-3">
                    <div className="text-ink text-sm font-semibold">Registrado como gasto</div>
                    <div className="text-ink-3 text-xs mt-0.5">El proveedor no tenía facturas pendientes</div>
                  </div>
                )}
                <button onClick={() => { setShowMove(false); setMoveAmount(''); resetMovementFields(); }}
                  className="w-full h-11 bg-success-soft hover:bg-success-soft text-success font-bold rounded-xl transition-colors">
                  Listo
                </button>
              </>
            ) : (
            <>
            {/* Toggle entrada / salida */}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => handleDirection('out')}
                className={`h-10 rounded-xl font-bold text-sm transition-colors ${
                  movDirection === 'out'
                    ? 'bg-danger-soft/30 border border-danger text-danger'
                    : 'bg-surface-2 border border-line text-ink-3'
                }`}>
                ↓ Sale dinero
              </button>
              <button onClick={() => handleDirection('in')}
                className={`h-10 rounded-xl font-bold text-sm transition-colors ${
                  movDirection === 'in'
                    ? 'bg-success-soft/40 border border-success text-success'
                    : 'bg-surface-2 border border-line text-ink-3'
                }`}>
                ↑ Entra dinero
              </button>
            </div>

            {/* Motivo */}
            <div>
              <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Motivo</label>
              <div className="grid grid-cols-2 gap-2">
                {motivosForDir.map(opt => (
                  <button key={opt.value} type="button"
                    onClick={() => { setMotivo(opt.value); resetMovementFields(); }}
                    className={`px-3 py-2 rounded-xl text-sm font-semibold border transition-colors text-left ${
                      motivo === opt.value
                        ? 'bg-primary-soft/30 border-primary text-primary'
                        : 'bg-bg border-line text-ink-3 hover:text-ink-2 hover:border-line-strong'
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
                <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Proveedor</label>
                {selectedSupplier ? (
                  <div>
                    <div className="flex items-center justify-between bg-primary-soft/30 border border-primary/40 rounded-xl px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="text-primary text-sm font-semibold truncate">{selectedSupplier.name}</div>
                        {selectedSupplier.company && (
                          <div className="text-ink-3 text-xs truncate">{selectedSupplier.company}</div>
                        )}
                      </div>
                      <button type="button" onClick={() => { setSelectedSupplier(null); setSupplierQuery(''); }}
                        className="text-ink-3 text-xs font-semibold hover:text-ink shrink-0 ml-2">
                        Cambiar
                      </button>
                    </div>
                    {/* Deuda pendiente del proveedor — se muestra apenas se carga */}
                    {outstandingLoading && (
                      <div className="text-ink-3 text-xs mt-1.5">Verificando facturas pendientes…</div>
                    )}
                    {!outstandingLoading && supplierOutstanding !== null && (
                      parseFloat(supplierOutstanding.totalOutstanding) > 0 ? (
                        <div className="mt-1.5 bg-warn-soft/30 border border-warn/40 rounded-xl px-3 py-2 text-xs text-warn font-medium">
                          Debe {COP(parseFloat(supplierOutstanding.totalOutstanding))} en {supplierOutstanding.invoiceCount} factura{supplierOutstanding.invoiceCount !== 1 ? 's' : ''}
                        </div>
                      ) : (
                        <div className="mt-1.5 bg-surface-2 border border-line rounded-xl px-3 py-2 text-xs text-ink-3">
                          Sin facturas pendientes — se registrará como gasto
                        </div>
                      )
                    )}
                  </div>
                ) : (
                  <>
                    <input type="text" value={supplierQuery} onChange={e => setSupplierQuery(e.target.value)}
                      placeholder="Buscar proveedor…"
                      className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
                    {supplierLoading ? (
                      <div className="text-ink-3 text-xs mt-1.5">Cargando proveedores…</div>
                    ) : suppliers.length === 0 ? (
                      <div className="text-ink-3 text-xs mt-1.5">No hay proveedores registrados. Escribe el nombre en la nota.</div>
                    ) : filteredSuppliers.length > 0 ? (
                      <div className="mt-1.5 max-h-40 overflow-y-auto rounded-xl border border-line divide-y divide-line">
                        {filteredSuppliers.slice(0, 8).map(s => (
                          <button key={s.id} type="button" onClick={() => { setSelectedSupplier(s); setSupplierQuery(''); }}
                            className="w-full text-left px-4 py-2.5 bg-surface hover:bg-surface-3 transition-colors">
                            <div className="text-ink text-sm font-medium truncate">{s.name}</div>
                            {s.company && <div className="text-ink-3 text-xs truncate">{s.company}</div>}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-ink-3 text-xs mt-1.5">Sin coincidencias. Escribe el nombre en la nota.</div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Monto */}
            {(() => {
              const outstandingCap =
                motivo === 'pago_proveedor' &&
                supplierOutstanding !== null &&
                parseFloat(supplierOutstanding.totalOutstanding) > 0
                  ? parseFloat(supplierOutstanding.totalOutstanding)
                  : null;
              const parsedAmt = parseFloat(moveAmount);
              const exceedsCap = outstandingCap !== null && !isNaN(parsedAmt) && parsedAmt > outstandingCap;
              return (
                <div>
                  <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Monto</label>
                  <input
                    type="number"
                    value={moveAmount}
                    onChange={e => setMoveAmount(e.target.value)}
                    placeholder="0"
                    min={0.01}
                    {...(outstandingCap !== null ? { max: outstandingCap } : {})}
                    className={`w-full bg-bg border rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors ${exceedsCap ? 'border-danger' : 'border-line'}`}
                  />
                  {exceedsCap && (
                    <div className="mt-1 text-danger text-xs font-medium">
                      Máximo: {COP(outstandingCap)} (lo que debe el proveedor)
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Nota con presets rápidos */}
            <div>
              <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">
                {motivo === 'otro' ? 'Descripción' : 'Nota (opcional)'}
              </label>
              {reasonPresets.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {reasonPresets.map(r => (
                    <button key={r} type="button" onClick={() => setMoveReason(r)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                        moveReason === r
                          ? 'bg-primary-soft/30 border-primary/40 text-primary'
                          : 'bg-bg border-line text-ink-3 hover:text-ink-2 hover:border-line-strong'
                      }`}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
              <input type="text" value={moveReason} onChange={e => setMoveReason(e.target.value)}
                placeholder={motivo === 'otro' ? 'Describe el motivo…' : 'Detalle adicional…'}
                className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
            </div>

            {error && <div className="text-danger text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleMove} disabled={moveBusy}
                className="h-11 bg-primary-soft hover:bg-primary-soft disabled:opacity-40 text-primary font-bold rounded-xl transition-colors">
                {moveBusy ? 'Guardando…' : 'Registrar'}
              </button>
              <button onClick={() => { setShowMove(false); resetMovementFields(); setError(''); }}
                className="h-11 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                Cancelar
              </button>
            </div>
            </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
