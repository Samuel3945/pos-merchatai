import { useState, useEffect, useCallback } from 'react';
import { api, CashSession, CashMovement, CashMovementType, SupplierLite, SupplierOutstanding, MovementOutcome, CourierWalletMe, CourierWalletBalance, EmployeeLite, OutstandingLoan } from '../services/api';
import {
  ENTRY_MOTIVOS,
  EXIT_MOTIVOS,
  REASON_PRESETS,
  composeMovement,
  type EntryMotivo,
  type ExitMotivo,
} from '../lib/cash-motivos';
import {
  queueCourierMove,
  getQueuedCourierMoves,
  syncCourierQueue,
  type QueuedCourierMove,
} from '../lib/offline';

const COP = (n: number) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

// Clave de caché del último estado conocido del bolsillo (para operar offline).
const WALLET_CACHE_KEY = 'pos_courier_wallet_cache';

// Una caída de red se manifiesta como TypeError ("Failed to fetch") en el WebView
// o como un string de host/conexión con CapacitorHttp (APK nativa). Tratamos ambos
// como "sin conexión" para encolar el movimiento en vez de perderlo. Mismo criterio
// que Pos.tsx.
function isNetworkError(e: any): boolean {
  if (e instanceof TypeError) return true;
  const msg = String(e?.message ?? e ?? '').toLowerCase();
  return /unable to resolve host|no address associated|failed to connect|network|timed? ?out|\bconnection\b|offline|err_internet|err_network|err_name_not_resolved|enotfound/.test(msg);
}

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
  // Facturas elegidas para pagar (como en el admin): payableId → seleccionada, y
  // el monto (total o parcial) por factura. Se inicializan al cargar la deuda:
  // todas marcadas con su saldo completo; el cajero destilda o edita.
  const [payableSel, setPayableSel]   = useState<Set<string>>(new Set());
  const [payableAmt, setPayableAmt]   = useState<Record<string, string>>({});
  // Resultado del último movimiento de "Pago a proveedor" / "Abono de préstamo":
  // indica si se saldaron facturas/préstamos o si se registró como gasto.
  const [moveOutcome, setMoveOutcome] = useState<MovementOutcome | null>(null);

  // Flags del negocio (de /pos/me). Delivery habilita el préstamo a domiciliario;
  // vales de empleado habilita crear/abonar préstamos. Empiezan en false hasta
  // que /pos/me responde (no mostramos algo que el plan no permite).
  const [deliveryEnabled, setDeliveryEnabled]           = useState(false);
  const [employeeLoansEnabled, setEmployeeLoansEnabled] = useState(false);

  // Empleado — solo para el motivo "Vale de empleado". Se elige de la lista
  // activa de la org (/pos/employees) y queda como destinatario del préstamo.
  const [employees, setEmployees]             = useState<EmployeeLite[]>([]);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<{ id: string; name: string } | null>(null);
  const [employeeQuery, setEmployeeQuery]     = useState('');

  // Préstamos pendientes (vales) para el motivo "Abono de préstamo". Se cargan al
  // montar la caja para saber si mostrar el motivo aunque el flag esté apagado.
  const [outstandingLoans, setOutstandingLoans] = useState<OutstandingLoan[]>([]);
  // Préstamos elegidos para abonar (como el checklist de facturas): loanId →
  // seleccionado, y el monto (total o parcial) por préstamo.
  const [loanSel, setLoanSel] = useState<Set<string>>(new Set());
  const [loanAmt, setLoanAmt] = useState<Record<string, string>>({});

  // Bolsillo del domiciliario (préstamos caja ↔ domiciliario). Los saldos que se
  // guardan aquí son los del ÚLTIMO estado conocido del servidor (o su caché
  // offline); los movimientos en cola se aplican encima al mostrar.
  const [walletMe, setWalletMe]         = useState<CourierWalletMe | null>(null);
  const [couriers, setCouriers]         = useState<CourierWalletBalance[]>([]);
  const [queuedMoves, setQueuedMoves]   = useState<QueuedCourierMove[]>([]);
  // Conexión: solo cambia a offline cuando el evento dispara explícitamente
  // (navigator.onLine es poco confiable al montar).
  const [online, setOnline]             = useState(true);
  // Modal "Préstamo a domiciliario" (base_from_caja).
  const [showLoan, setShowLoan]         = useState(false);
  const [loanCourierId, setLoanCourierId] = useState('');
  const [loanAmount, setLoanAmount]     = useState('');
  const [loanBusy, setLoanBusy]         = useState(false);
  // Modal "Entregar a caja" del propio domiciliario (handover_to_caja).
  const [showHandover, setShowHandover] = useState(false);
  const [handoverAmount, setHandoverAmount] = useState('');
  const [handoverBusy, setHandoverBusy] = useState(false);

  const refreshQueued = useCallback(async () => {
    try { setQueuedMoves(await getQueuedCourierMoves()); } catch { /* noop */ }
  }, []);

  const loadWallet = useCallback(async () => {
    try {
      const w = await api.courierWallet.overview();
      setWalletMe(w.me);
      setCouriers(w.couriers || []);
      // Cachea el último estado conocido para poder operar sin conexión.
      try { localStorage.setItem(WALLET_CACHE_KEY, JSON.stringify(w)); } catch { /* noop */ }
    } catch {
      // Sin conexión: usa el último estado conocido para no romper la caja.
      try {
        const raw = localStorage.getItem(WALLET_CACHE_KEY);
        if (raw) {
          const w = JSON.parse(raw) as { me: CourierWalletMe | null; couriers: CourierWalletBalance[] };
          setWalletMe(w.me);
          setCouriers(w.couriers || []);
        }
      } catch { /* noop */ }
    }
    refreshQueued();
  }, [refreshQueued]);

  // Reenvía la cola del bolsillo (idempotente por clientMovementId en el backend).
  const syncCourier = useCallback(async () => {
    const pending = await getQueuedCourierMoves().catch(() => []);
    if (pending.length === 0) { return; }
    await syncCourierQueue(
      async (m) => {
        await api.courierWallet.move({
          direction: m.direction,
          amount: m.amount,
          courierId: m.courierId,
          note: m.note,
          clientMovementId: m.clientMovementId,
        });
      },
      () => { /* se conserva en cola para el próximo intento */ },
    );
    await refreshQueued();
    loadWallet();
  }, [refreshQueued, loadWallet]);

  const resetMovementFields = () => {
    setMoveReason('');
    setSelectedSupplier(null);
    setSupplierQuery('');
    setSupplierOutstanding(null);
    setPayableSel(new Set());
    setPayableAmt({});
    setMoveOutcome(null);
    setSelectedEmployee(null);
    setEmployeeQuery('');
    setLoanSel(new Set());
    setLoanAmt({});
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

  // Préstamos pendientes (org-wide). Se recarga tras crear/abonar un vale para
  // reflejar el nuevo saldo en el checklist de "Abono de préstamo".
  const loadLoans = useCallback(async () => {
    try { setOutstandingLoans((await api.employeeLoans.outstanding()).loans || []); }
    catch { /* degradamos: sin préstamos no se ofrece abonar */ }
  }, []);

  useEffect(() => { load(); loadWallet(); loadLoans(); }, [load, loadWallet, loadLoans]);

  // Flags del negocio: delivery (préstamo a domiciliario) y vales de empleado.
  useEffect(() => {
    api.pos.me()
      .then(me => {
        setDeliveryEnabled(!!me.features?.deliveryEnabled);
        setEmployeeLoansEnabled(!!me.features?.employeeLoansEnabled);
      })
      .catch(() => { /* sin flags: se ocultan las funciones dependientes */ });
  }, []);

  // Intento inicial de drenar la cola del bolsillo (por si quedaron movimientos
  // de una sesión offline previa) y reintento en cada reconexión.
  useEffect(() => {
    syncCourier();
    const onOnline = () => { setOnline(true); syncCourier(); load(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [syncCourier, load]);

  const showOk = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  // UUID de dispositivo para idempotencia offline (mismo patrón que las ventas).
  const genUuid = () =>
    (globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

  // Caja → domiciliario: la caja le presta base para dar vuelto. Funciona offline:
  // si la red falla, se encola y se sincroniza al reconectar (idempotente).
  const handleLoan = async () => {
    const amt = parseFloat(loanAmount);
    if (!amt || amt <= 0) { setError('Ingresa un monto válido'); return; }
    if (!loanCourierId) { setError('Elige a quién le prestas'); return; }
    setLoanBusy(true); setError('');
    const clientMovementId = genUuid();
    const courierName = couriers.find(c => c.courierId === loanCourierId)?.name;
    try {
      await api.courierWallet.move({ direction: 'base_from_caja', amount: amt, courierId: loanCourierId, clientMovementId });
      setShowLoan(false); setLoanAmount(''); setLoanCourierId('');
      showOk('Préstamo registrado');
      load(); loadWallet();
    } catch (e: any) {
      if (isNetworkError(e)) {
        await queueCourierMove({ direction: 'base_from_caja', amount: amt, courierId: loanCourierId, courierName, clientMovementId });
        setShowLoan(false); setLoanAmount(''); setLoanCourierId('');
        showOk('Guardado sin conexión — se sincroniza al reconectar');
        setOnline(false); refreshQueued();
      } else { setError(e.message || 'No se pudo registrar el préstamo'); }
    }
    finally { setLoanBusy(false); }
  };

  // Domiciliario → caja: entrega efectivo (billetes grandes) a la caja. Offline igual.
  const handleHandover = async () => {
    const amt = parseFloat(handoverAmount);
    if (!amt || amt <= 0) { setError('Ingresa un monto válido'); return; }
    if (!walletMe) { return; }
    setHandoverBusy(true); setError('');
    const clientMovementId = genUuid();
    const courierId = walletMe.courierId;
    try {
      await api.courierWallet.move({ direction: 'handover_to_caja', amount: amt, courierId, clientMovementId });
      setShowHandover(false); setHandoverAmount('');
      showOk('Entrega registrada');
      load(); loadWallet();
    } catch (e: any) {
      if (isNetworkError(e)) {
        await queueCourierMove({ direction: 'handover_to_caja', amount: amt, courierId, clientMovementId });
        setShowHandover(false); setHandoverAmount('');
        showOk('Guardado sin conexión — se sincroniza al reconectar');
        setOnline(false); refreshQueued();
      } else { setError(e.message || 'No se pudo registrar la entrega'); }
    }
    finally { setHandoverBusy(false); }
  };

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

  // Carga perezosa de empleados la primera vez que el cajero elige "Vale de
  // empleado". Si falla, no se puede elegir destinatario y el confirm queda
  // bloqueado (no dejamos crear un vale sin empleado).
  useEffect(() => {
    if (motivo !== 'vale_empleado' || employees.length > 0 || employeeLoading) return;
    setEmployeeLoading(true);
    api.employees.list()
      .then(d => setEmployees(d.employees || []))
      .catch(() => setEmployees([]))
      .finally(() => setEmployeeLoading(false));
  }, [motivo, employees.length, employeeLoading]);

  // Al elegir "Abono de préstamo": todos los préstamos marcados con su saldo
  // completo (el cajero destilda o edita). Se re-inicializa si cambian los datos.
  useEffect(() => {
    if (motivo !== 'abono_prestamo') return;
    setLoanSel(new Set(outstandingLoans.map(l => l.loanId)));
    setLoanAmt(Object.fromEntries(outstandingLoans.map(l => [l.loanId, String(l.outstanding)])));
  }, [motivo, outstandingLoans]);

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
      .then((data) => {
        if (!active) return;
        setSupplierOutstanding(data);
        // Por defecto: todas las facturas marcadas con su saldo completo.
        setPayableSel(new Set(data.invoices.map(i => i.payableId)));
        setPayableAmt(Object.fromEntries(data.invoices.map(i => [i.payableId, String(i.outstanding)])));
      })
      .catch(() => { if (active) { setSupplierOutstanding(null); setPayableSel(new Set()); setPayableAmt({}); } })
      .finally(() => { if (active) setOutstandingLoading(false); });
    return () => { active = false; };
  }, [selectedSupplier]);

  const handleMove = async () => {
    // Vale de empleado (Salida): crea un préstamo a nombre del empleado elegido.
    if (motivo === 'vale_empleado') {
      const amt = parseFloat(moveAmount);
      if (!amt || amt <= 0) { setError('Ingresa un monto válido'); return; }
      if (!selectedEmployee) { setError('Elige un empleado'); return; }
      const { type, reason } = composeMovement(movDirection, motivo, moveReason);
      setMoveBusy(true); setError('');
      try {
        await api.cash.addMovement(type, amt, reason, null, null, {
          employeeId: selectedEmployee.id,
          loanKind: 'employee_loan',
        });
        setShowMove(false); setMoveAmount(''); resetMovementFields();
        showOk('Vale registrado');
        load(); loadLoans();
      } catch (e: any) { setError(e.message || 'Error al registrar'); }
      finally { setMoveBusy(false); }
      return;
    }

    // Abono de préstamo (Entrada): el monto sale de los préstamos seleccionados.
    if (motivo === 'abono_prestamo') {
      const chosen = outstandingLoans.filter(l => loanSel.has(l.loanId));
      const loanSelections = chosen
        .map(l => ({ loanId: l.loanId, amount: parseFloat(loanAmt[l.loanId] ?? '0') || 0 }))
        .filter(s => s.amount > 0);
      if (loanSelections.length === 0) { setError('Elige al menos un préstamo con monto'); return; }
      // Ningún abono por encima de su saldo.
      const over = chosen.find(l => (parseFloat(loanAmt[l.loanId] ?? '0') || 0) > l.outstanding + 0.001);
      if (over) { setError('Un abono supera el saldo del préstamo. Reduce el monto.'); return; }
      const amt = loanSelections.reduce((s, x) => s + x.amount, 0);
      const { type, reason } = composeMovement(movDirection, motivo, moveReason);
      setMoveBusy(true); setError('');
      try {
        const result = await api.cash.addMovement(type, amt, reason, null, null, { loanSelections });
        if (result.outcome) {
          setMoveOutcome({ outcome: result.outcome, appliedTotal: result.appliedTotal, settledPayables: result.settledPayables });
        } else {
          setShowMove(false); setMoveAmount(''); resetMovementFields();
          showOk('Abono registrado');
        }
        load(); loadLoans();
      } catch (e: any) { setError(e.message || 'Error al registrar'); }
      finally { setMoveBusy(false); }
      return;
    }

    // Pago a proveedor con facturas seleccionadas: el monto sale de las facturas.
    const invs = supplierOutstanding?.invoices ?? [];
    const useSelection = motivo === 'pago_proveedor' && invs.length > 0;

    let amt: number;
    let selections: { payableId: string; amount: number }[] | null = null;

    if (useSelection) {
      const chosen = invs.filter(i => payableSel.has(i.payableId));
      selections = chosen
        .map(i => ({ payableId: i.payableId, amount: parseFloat(payableAmt[i.payableId] ?? '0') || 0 }))
        .filter(s => s.amount > 0);
      if (selections.length === 0) { setError('Elige al menos una factura con monto'); return; }
      // Ninguna factura por encima de su saldo.
      const over = chosen.find(i => (parseFloat(payableAmt[i.payableId] ?? '0') || 0) > (parseFloat(i.outstanding) || 0) + 0.001);
      if (over) { setError('Una factura supera su saldo pendiente. Reduce el monto.'); return; }
      amt = selections.reduce((s, x) => s + x.amount, 0);
    } else {
      amt = parseFloat(moveAmount);
      if (!amt || amt <= 0) { setError('Ingresa un monto válido'); return; }
      // Block overpay on the generic settle path (backend also rejects).
      if (
        motivo === 'pago_proveedor' &&
        supplierOutstanding !== null &&
        parseFloat(supplierOutstanding.totalOutstanding) > 0 &&
        amt > parseFloat(supplierOutstanding.totalOutstanding)
      ) {
        setError(`El monto supera la deuda del proveedor (${COP(parseFloat(supplierOutstanding.totalOutstanding))}). Reducí el monto o registralo como gasto aparte.`);
        return;
      }
    }
    const { type, reason } = composeMovement(movDirection, motivo, moveReason, selectedSupplier?.name);
    setMoveBusy(true); setError('');
    try {
      const result = await api.cash.addMovement(type, amt, reason, selectedSupplier?.id ?? null, selections);
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
  // "Vale de empleado" solo si el negocio tiene vales activos. "Abono de préstamo"
  // si están activos O hay al menos un préstamo pendiente (para poder cobrar
  // aunque el flag se apague después). El resto de motivos siempre están.
  const canRepayLoans = employeeLoansEnabled || outstandingLoans.length > 0;
  const exitMotivos  = EXIT_MOTIVOS.filter(o => o.value !== 'vale_empleado' || employeeLoansEnabled);
  const entryMotivos = ENTRY_MOTIVOS.filter(o => o.value !== 'abono_prestamo' || canRepayLoans);
  const motivosForDir = movDirection === 'out' ? exitMotivos : entryMotivos;
  const reasonPresets = REASON_PRESETS[motivo] || [];

  // Saldos a mostrar = último conocido del servidor + movimientos aún en cola
  // (offline). base_from_caja suma; handover_to_caja resta al mismo domiciliario.
  const queuedDeltaFor = (courierId: string) =>
    queuedMoves
      .filter(m => m.courierId === courierId)
      .reduce((acc, m) => acc + (m.direction === 'base_from_caja' ? m.amount : -m.amount), 0);
  const displayCouriers = couriers.map(c => ({ ...c, balance: c.balance + queuedDeltaFor(c.courierId) }));
  const displayMeBalance = walletMe ? walletMe.balance + queuedDeltaFor(walletMe.courierId) : 0;
  const pendingCount = queuedMoves.length;

  const supplierQ = supplierQuery.trim().toLowerCase();
  const filteredSuppliers = supplierQ
    ? suppliers.filter(s =>
        s.name.toLowerCase().includes(supplierQ)
        || (s.company || '').toLowerCase().includes(supplierQ))
    : suppliers;

  const employeeQ = employeeQuery.trim().toLowerCase();
  const filteredEmployees = employeeQ
    ? employees.filter(e => e.name.toLowerCase().includes(employeeQ))
    : employees;

  const totalMov = movements
    .filter(m => m.type !== 'sale')
    .reduce((acc, m) => INFLOW_TYPES.has(m.type) ? acc + Number(m.amount) : acc - Number(m.amount), 0);

  // Ventas en efectivo del turno (las que ya están contadas dentro de `expected`).
  const cashSales = movements
    .filter(m => m.type === 'sale')
    .reduce((acc, m) => acc + Number(m.amount), 0);

  // Pago a proveedor con facturas: usamos selección de facturas cuando el
  // proveedor tiene facturas pendientes. El monto sale de las facturas elegidas.
  const invoices = supplierOutstanding?.invoices ?? [];
  const usingInvoiceSelection = motivo === 'pago_proveedor' && invoices.length > 0;
  const selectedPayableTotal = invoices
    .filter(i => payableSel.has(i.payableId))
    .reduce((s, i) => s + (parseFloat(payableAmt[i.payableId] ?? '0') || 0), 0);

  // Abono de préstamo: el monto sale de los préstamos elegidos (se oculta el
  // campo de monto libre, igual que con la selección de facturas).
  const usingLoanSelection = motivo === 'abono_prestamo';
  const selectedLoanTotal = outstandingLoans
    .filter(l => loanSel.has(l.loanId))
    .reduce((s, l) => s + (parseFloat(loanAmt[l.loanId] ?? '0') || 0), 0);

  // El confirm exige: vale → empleado + monto; abono → total > 0.
  const confirmDisabled =
    moveBusy
    || (motivo === 'vale_empleado' && (!selectedEmployee || !(parseFloat(moveAmount) > 0)))
    || (motivo === 'abono_prestamo' && selectedLoanTotal <= 0);

  // Conteo a ciegas: NO calculamos ni mostramos diferencias mientras el cajero
  // tipea. La diferencia se revela solo después de confirmar (openResult /
  // closeResult), para que no pueda ajustar el conteo hasta que "cuadre".

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-6 space-y-4">

        {success && <div className="px-4 py-2.5 bg-success-soft border border-success/40 text-success rounded-xl text-sm font-semibold">✓ {success}</div>}
        {error   && <div className="px-4 py-2.5 bg-danger-soft/30 border border-danger text-danger rounded-xl text-sm">{error}</div>}

        {/* Cola offline del bolsillo: movimientos guardados sin conexión, por subir */}
        {pendingCount > 0 && (
          <button onClick={syncCourier} disabled={!online}
            className="w-full px-4 py-2.5 bg-warn-soft border border-warn/40 text-warn rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-70">
            <span className="material-symbols-outlined text-[16px]">{online ? 'sync' : 'cloud_off'}</span>
            {pendingCount} movimiento{pendingCount !== 1 ? 's' : ''} del domiciliario sin sincronizar
            {online ? ' · toca para reintentar' : ''}
          </button>
        )}

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

        {/* Bolsillo del domiciliario (cuando el operador activo es domiciliario) */}
        {walletMe?.isCourier && (
          <div className="rounded-2xl p-5 border bg-primary-soft/20 border-primary/30">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-1 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[15px]">two_wheeler</span>
                  Llevas encima
                </div>
                <div className="font-black text-2xl text-primary tabular-nums">{COP(displayMeBalance)}</div>
                <div className="text-ink-3 text-xs mt-1">Efectivo tuyo por entregar a caja</div>
              </div>
              <button onClick={() => { setHandoverAmount(''); setError(''); setShowHandover(true); }}
                className="h-11 px-4 bg-primary hover:bg-primary-ink text-white font-bold rounded-xl flex items-center justify-center gap-1.5 text-sm transition-colors active:scale-[0.98]">
                <span className="material-symbols-outlined text-[18px]">payments</span>
                Entregar a caja
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        {!isOpen ? (
          <button onClick={() => { setOpenResult(null); setError(''); setShowOpen(true); }}
            className="w-full h-14 bg-primary hover:bg-primary-ink text-white font-bold rounded-2xl flex items-center justify-center gap-2 text-base transition-colors active:scale-[0.98]">
            <span className="material-symbols-outlined">lock_open</span>
            Abrir caja
          </button>
        ) : (
          <div className="space-y-3">
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
            {deliveryEnabled && couriers.length > 0 && (
              <button onClick={() => { setLoanAmount(''); setLoanCourierId(couriers[0]?.courierId || ''); setError(''); setShowLoan(true); }}
                className="w-full h-12 bg-surface border border-line-strong text-ink font-bold rounded-xl flex items-center justify-center gap-1.5 text-sm transition-colors hover:border-primary hover:text-primary active:scale-[0.98]">
                <span className="material-symbols-outlined text-[18px]">volunteer_activism</span>
                Prestar a domiciliario
              </button>
            )}
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
                      {motivo === 'abono_prestamo' ? 'Préstamos abonados' : 'Facturas saldadas'} — {COP(parseFloat(moveOutcome.appliedTotal || '0'))}
                    </div>
                    {(moveOutcome.settledPayables ?? 0) > 0 && (
                      motivo === 'abono_prestamo' ? (
                        <div className="text-ink-3 text-xs">
                          {moveOutcome.settledPayables} préstamo{moveOutcome.settledPayables !== 1 ? 's' : ''} cerrado{moveOutcome.settledPayables !== 1 ? 's' : ''}
                        </div>
                      ) : (
                        <div className="text-ink-3 text-xs">
                          {moveOutcome.settledPayables} factura{moveOutcome.settledPayables !== 1 ? 's' : ''} cerrada{moveOutcome.settledPayables !== 1 ? 's' : ''}
                        </div>
                      )
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
                      invoices.length > 0 ? (
                        <div className="mt-1.5 space-y-1.5">
                          <div className="text-ink-3 text-[11px] font-semibold uppercase tracking-wider">
                            ¿Qué facturas pagas?
                          </div>
                          <div className="max-h-52 overflow-y-auto rounded-xl border border-line divide-y divide-line">
                            {invoices.map((inv) => {
                              const on = payableSel.has(inv.payableId);
                              const cap = parseFloat(inv.outstanding) || 0;
                              return (
                                <div key={inv.payableId} className="flex items-center gap-2 px-3 py-2 bg-surface">
                                  <button type="button"
                                    onClick={() => setPayableSel(prev => {
                                      const n = new Set(prev);
                                      if (n.has(inv.payableId)) n.delete(inv.payableId); else n.add(inv.payableId);
                                      return n;
                                    })}
                                    className={`shrink-0 w-5 h-5 rounded-md border flex items-center justify-center ${on ? 'bg-primary border-primary text-white' : 'border-line-strong'}`}>
                                    {on && <span className="material-symbols-outlined text-[14px]">check</span>}
                                  </button>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-ink text-sm font-medium truncate">
                                      {inv.invoiceNumber ? `Factura ${inv.invoiceNumber}` : 'Factura'}
                                      {inv.status === 'partial' && <span className="text-warn text-[11px] ml-1">· abonada</span>}
                                    </div>
                                    <div className="text-ink-3 text-[11px]">Debe {COP(cap)}</div>
                                  </div>
                                  <input type="number" inputMode="numeric"
                                    value={payableAmt[inv.payableId] ?? ''}
                                    disabled={!on}
                                    onChange={e => setPayableAmt(prev => ({ ...prev, [inv.payableId]: e.target.value }))}
                                    className={`w-24 shrink-0 bg-bg border rounded-lg px-2 py-1.5 text-ink text-sm text-right tabular-nums outline-none focus:border-primary ${(parseFloat(payableAmt[inv.payableId] ?? '0') || 0) > cap ? 'border-danger' : 'border-line'} ${!on ? 'opacity-40' : ''}`} />
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex items-center justify-between px-1 text-sm">
                            <span className="text-ink-3">Total a pagar</span>
                            <span className="font-bold text-ink tabular-nums">{COP(selectedPayableTotal)}</span>
                          </div>
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

            {/* Empleado — solo en "Vale de empleado". Se elige de la lista activa;
                es obligatorio (el confirm queda bloqueado sin empleado). */}
            {motivo === 'vale_empleado' && (
              <div>
                <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">Empleado</label>
                {selectedEmployee ? (
                  <div className="flex items-center justify-between bg-primary-soft/30 border border-primary/40 rounded-xl px-4 py-2.5">
                    <div className="text-primary text-sm font-semibold truncate">{selectedEmployee.name}</div>
                    <button type="button" onClick={() => { setSelectedEmployee(null); setEmployeeQuery(''); }}
                      className="text-ink-3 text-xs font-semibold hover:text-ink shrink-0 ml-2">
                      Cambiar
                    </button>
                  </div>
                ) : (
                  <>
                    <input type="text" value={employeeQuery} onChange={e => setEmployeeQuery(e.target.value)}
                      placeholder="Buscar empleado…"
                      className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
                    {employeeLoading ? (
                      <div className="text-ink-3 text-xs mt-1.5">Cargando empleados…</div>
                    ) : employees.length === 0 ? (
                      <div className="text-ink-3 text-xs mt-1.5">No hay empleados registrados.</div>
                    ) : filteredEmployees.length > 0 ? (
                      <div className="mt-1.5 max-h-40 overflow-y-auto rounded-xl border border-line divide-y divide-line">
                        {filteredEmployees.slice(0, 8).map(emp => (
                          <button key={emp.id} type="button" onClick={() => { setSelectedEmployee(emp); setEmployeeQuery(''); }}
                            className="w-full text-left px-4 py-2.5 bg-surface hover:bg-surface-3 transition-colors">
                            <div className="text-ink text-sm font-medium truncate">{emp.name}</div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-ink-3 text-xs mt-1.5">Sin coincidencias.</div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Abono de préstamo — checklist de préstamos pendientes (como las
                facturas de proveedor): elige cuáles abonar y cuánto por cada uno. */}
            {motivo === 'abono_prestamo' && (
              <div>
                <label className="block text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1.5">¿Qué préstamos abonas?</label>
                {outstandingLoans.length === 0 ? (
                  <div className="bg-surface-2 border border-line rounded-xl px-3 py-2 text-xs text-ink-3">
                    No hay préstamos pendientes.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="max-h-52 overflow-y-auto rounded-xl border border-line divide-y divide-line">
                      {outstandingLoans.map(loan => {
                        const on = loanSel.has(loan.loanId);
                        const cap = loan.outstanding;
                        return (
                          <div key={loan.loanId} className="flex items-center gap-2 px-3 py-2 bg-surface">
                            <button type="button"
                              onClick={() => setLoanSel(prev => {
                                const n = new Set(prev);
                                if (n.has(loan.loanId)) n.delete(loan.loanId); else n.add(loan.loanId);
                                return n;
                              })}
                              className={`shrink-0 w-5 h-5 rounded-md border flex items-center justify-center ${on ? 'bg-primary border-primary text-white' : 'border-line-strong'}`}>
                              {on && <span className="material-symbols-outlined text-[14px]">check</span>}
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="text-ink text-sm font-medium truncate">{loan.employeeName}</div>
                              <div className="text-ink-3 text-[11px]">
                                Debe {COP(cap)} · {new Date(loan.createdAt).toLocaleDateString('es-CO')}
                              </div>
                            </div>
                            <input type="number" inputMode="numeric"
                              value={loanAmt[loan.loanId] ?? ''}
                              disabled={!on}
                              onChange={e => setLoanAmt(prev => ({ ...prev, [loan.loanId]: e.target.value }))}
                              className={`w-24 shrink-0 bg-bg border rounded-lg px-2 py-1.5 text-ink text-sm text-right tabular-nums outline-none focus:border-primary ${(parseFloat(loanAmt[loan.loanId] ?? '0') || 0) > cap ? 'border-danger' : 'border-line'} ${!on ? 'opacity-40' : ''}`} />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between px-1 text-sm">
                      <span className="text-ink-3">Total a abonar</span>
                      <span className="font-bold text-ink tabular-nums">{COP(selectedLoanTotal)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Monto — se oculta cuando se paga por selección de facturas o por
                abono de préstamo (el monto sale de la selección). */}
            {!usingInvoiceSelection && !usingLoanSelection && (() => {
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
                Nota (opcional)
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
                placeholder="Detalle adicional…"
                className="w-full bg-bg border border-line rounded-xl px-4 py-2.5 text-ink text-sm focus:border-primary outline-none transition-colors" />
            </div>

            {error && <div className="text-danger text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleMove} disabled={confirmDisabled}
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

      {/* Modal: prestar base a un domiciliario (caja → domiciliario) */}
      {showLoan && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink text-lg">Prestar a domiciliario</h2>
              <button onClick={() => { setShowLoan(false); setError(''); }} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <p className="text-ink-3 text-xs -mt-2">Le entregas base para que dé vuelto. Sale del cajón y queda a su nombre.</p>

            <div>
              <div className="text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-2">¿A quién?</div>
              <div className="space-y-2">
                {displayCouriers.map(c => (
                  <button key={c.courierId} onClick={() => setLoanCourierId(c.courierId)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm transition-colors ${
                      loanCourierId === c.courierId
                        ? 'bg-primary-soft/30 border-primary text-primary font-bold'
                        : 'bg-surface-2 border-line text-ink'
                    }`}>
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px]">two_wheeler</span>
                      {c.name}
                    </span>
                    <span className="text-ink-3 text-xs tabular-nums">lleva {COP(c.balance)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-1">Monto</div>
              <input type="number" inputMode="numeric" value={loanAmount} onChange={e => setLoanAmount(e.target.value)}
                placeholder="0" autoFocus
                className="w-full h-12 bg-bg border border-line rounded-xl px-4 text-ink text-lg font-bold tabular-nums outline-none focus:border-primary" />
            </div>

            {error && <div className="text-danger text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleLoan} disabled={loanBusy}
                className="h-11 bg-primary-soft hover:bg-primary-soft disabled:opacity-40 text-primary font-bold rounded-xl transition-colors">
                {loanBusy ? 'Guardando…' : 'Prestar'}
              </button>
              <button onClick={() => { setShowLoan(false); setError(''); }}
                className="h-11 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: el domiciliario entrega efectivo a la caja (domiciliario → caja) */}
      {showHandover && walletMe && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface border border-line rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-ink text-lg">Entregar a caja</h2>
              <button onClick={() => { setShowHandover(false); setError(''); }} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="bg-surface-2 border border-line rounded-xl px-4 py-3">
              <div className="text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-0.5">Llevas encima</div>
              <div className="text-ink font-black text-xl tabular-nums">{COP(walletMe.balance)}</div>
            </div>

            <div>
              <div className="text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-1">¿Cuánto entregas?</div>
              <input type="number" inputMode="numeric" value={handoverAmount} onChange={e => setHandoverAmount(e.target.value)}
                placeholder="0" autoFocus
                className="w-full h-12 bg-bg border border-line rounded-xl px-4 text-ink text-lg font-bold tabular-nums outline-none focus:border-primary" />
              <p className="text-ink-3 text-xs mt-1.5">Entrega los billetes grandes; quédate con los pequeños para dar vuelto.</p>
            </div>

            {error && <div className="text-danger text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-2">
              <button onClick={handleHandover} disabled={handoverBusy}
                className="h-11 bg-primary-soft hover:bg-primary-soft disabled:opacity-40 text-primary font-bold rounded-xl transition-colors">
                {handoverBusy ? 'Guardando…' : 'Entregar'}
              </button>
              <button onClick={() => { setShowHandover(false); setError(''); }}
                className="h-11 bg-surface-2 border border-line text-ink-2 font-semibold rounded-xl hover:bg-surface-3 transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
