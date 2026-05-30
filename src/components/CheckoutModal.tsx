import { useEffect, useMemo, useRef, useState } from 'react';
import { PaymentMethod, SalePayment } from '../services/api';

const COP = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('es-CO')}`;

// Denominaciones más comunes que un cliente entrega en Colombia.
const QUICK_BILLS = [2000, 5000, 10000, 20000, 50000, 100000];

type Method = { name: string; icon: string; type: string };

type DraftPayment = {
  method: string;
  amount: string;
  reference?: string;
};

type Step = 'payment' | 'invoice_ask' | 'invoice_data';

interface Props {
  total: number;
  paymentMethods: PaymentMethod[];
  fiadoEnabled: boolean;
  canConfirmTransfers?: boolean;
  onConfirm: (payments: SalePayment[], notes?: string) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos compartidos por método (background + texto + acento de borde)
// ─────────────────────────────────────────────────────────────────────────────

// Métodos de transferencia: el unificado 'transfer' y los legacy 'nequi'/'llave'.
// Todos colapsan en un único botón "Transferencia" para el cajero.
function isTransferType(type: string) {
  return type === 'transfer' || type === 'nequi' || type === 'llave';
}

function methodTheme(type: string, _name: string) {
  if (type === 'cash')   return { bg: 'bg-[#0c4029]', hov: 'hover:bg-[#12533a]', txt: 'text-[#95d4b3]', ring: 'ring-[#95d4b3]', soft: 'bg-[#12533a]/30' };
  if (type === 'fiado')  return { bg: 'bg-[#5d4000]', hov: 'hover:bg-[#6d4d00]', txt: 'text-[#ffba27]', ring: 'ring-[#ffba27]', soft: 'bg-[#5d4000]/30' };
  if (type === 'card')   return { bg: 'bg-[#1a3a5c]', hov: 'hover:bg-[#234d75]', txt: 'text-[#9acee1]', ring: 'ring-[#9acee1]', soft: 'bg-[#1a3a5c]/30' };
  // 'transfer' (y cualquier otro tipo) → mismo tema azul de transferencia.
  return { bg: 'bg-[#0f4c5c]', hov: 'hover:bg-[#155a6d]', txt: 'text-[#9acee1]', ring: 'ring-[#9acee1]', soft: 'bg-[#0f4c5c]/30' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal principal
// ─────────────────────────────────────────────────────────────────────────────

export default function CheckoutModal({ total, paymentMethods, fiadoEnabled, canConfirmTransfers = true, onConfirm, onCancel, loading }: Props) {
  const availableMethods = useMemo<Method[]>(() => {
    const list: Method[] = [];
    const activeCustom = paymentMethods.filter(pm => pm.active);
    // Todas las cuentas de transferencia se colapsan en un único botón "Transferencia".
    // Solo se muestran si el cajero tiene permiso para confirmarlas.
    const hasTransfer = canConfirmTransfers && activeCustom.some(pm => isTransferType(pm.type));
    for (const pm of activeCustom) {
      if (isTransferType(pm.type)) continue;
      list.push({ name: pm.name, icon: pm.icon || 'payment', type: pm.type });
    }
    if (hasTransfer) {
      list.push({ name: 'Transferencia', icon: 'account_balance', type: 'transfer' });
    }
    // Efectivo siempre disponible — es el medio de pago universal en tienda de barrio.
    if (!list.find(m => m.name === 'Efectivo' || m.type === 'cash')) {
      list.unshift({ name: 'Efectivo', icon: 'payments', type: 'cash' });
    }
    if (fiadoEnabled && !list.find(m => m.name === 'Fiado')) {
      list.push({ name: 'Fiado', icon: 'handshake', type: 'fiado' });
    }
    return list;
  }, [paymentMethods, fiadoEnabled, canConfirmTransfers]);

  const allowMultiple = availableMethods.length > 1;

  const [step, setStep] = useState<Step>('payment');
  const [drafts, setDrafts] = useState<DraftPayment[]>([{ method: 'Efectivo', amount: String(total) }]);
  const [combineMode, setCombineMode] = useState(false);
  const [fiadoName, setFiadoName] = useState('');
  const [fiadoPhone, setFiadoPhone] = useState('');
  const [fiadoWhen, setFiadoWhen] = useState('');
  const [error, setError] = useState('');

  // Datos de factura
  const [invWhats, setInvWhats] = useState('');
  const [invName, setInvName] = useState('');
  const [invDoc, setInvDoc] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [invAddress, setInvAddress] = useState('');
  const [invErr, setInvErr] = useState('');

  // Sincroniza el primer draft cuando los métodos llegan tarde.
  useEffect(() => {
    if (availableMethods.length > 0 && !availableMethods.find(m => m.name === drafts[0]?.method)) {
      setDrafts([{ method: availableMethods[0].name, amount: String(total) }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableMethods.length]);

  const computedAmount = (d: DraftPayment) => parseFloat(d.amount) || 0;

  const totals = useMemo(() => {
    let appliedToBill = 0;
    let cashHandedIn = 0;
    for (const d of drafts) {
      const v = computedAmount(d);
      if (d.method === 'Efectivo') cashHandedIn += v;
      else appliedToBill += v;
    }
    const remainingBeforeCash = Math.max(0, total - appliedToBill);
    const cashApplied = Math.min(cashHandedIn, remainingBeforeCash);
    appliedToBill += cashApplied;
    const change = Math.max(0, cashHandedIn - cashApplied);
    const remaining = Math.max(0, total - appliedToBill);
    return { appliedToBill, cashHandedIn, cashApplied, change, remaining };
  }, [drafts, total]);

  const canConfirm = totals.remaining === 0 && drafts.some(d => computedAmount(d) > 0);
  const usingFiado = drafts.some(d => d.method === 'Fiado');

  // ── Acciones rápidas ──────────────────────────────────────────────────────
  const pickExact = (m: Method) => {
    setDrafts([{ method: m.name, amount: String(total) }]);
    setCombineMode(false);
  };

  const pickCashReceived = (received: number) => {
    setDrafts([{ method: 'Efectivo', amount: String(received) }]);
    setCombineMode(false);
  };

  const updateDraft = (idx: number, patch: Partial<DraftPayment>) => {
    setDrafts(ds => ds.map((d, i) => i === idx ? { ...d, ...patch } : d));
  };
  const removeDraft = (idx: number) => setDrafts(ds => ds.filter((_, i) => i !== idx));
  const addDraft = (methodName?: string) => {
    const remaining = totals.remaining;
    const next = methodName
      ?? availableMethods.find(m => !drafts.find(d => d.method === m.name))?.name
      ?? availableMethods[0]?.name ?? 'Efectivo';
    setDrafts(ds => [...ds, { method: next, amount: remaining > 0 ? String(remaining) : '' }]);
  };

  // ── Confirmar pago → siguiente paso (factura) ─────────────────────────────
  const advanceToInvoice = () => {
    setError('');
    if (totals.remaining > 0) { setError(`Faltan ${COP(totals.remaining)} por pagar`); return; }
    // Validar datos de fiado antes de avanzar para no perderlos en el paso siguiente.
    if (usingFiado && !fiadoName.trim()) {
      setError('El nombre del cliente es obligatorio para registrar el fiado');
      return;
    }
    setStep('invoice_ask');
  };

  const submit = async (invoice: boolean) => {
    setError(''); setInvErr('');
    if (usingFiado && !fiadoName.trim()) {
      setError('El nombre del cliente es obligatorio para registrar el fiado');
      return;
    }
    if (invoice) {
      const wa = invWhats.replace(/\D/g, '');
      if (wa.length < 7) { setInvErr('El WhatsApp es obligatorio para enviar la factura'); return; }
      if (!invName.trim()) { setInvErr('El nombre del cliente es obligatorio'); return; }
    }

    const payments: SalePayment[] = [];
    let cashRemaining = totals.cashApplied;
    let cashChange = totals.change;
    for (const d of drafts) {
      const handed = computedAmount(d);
      if (handed <= 0) continue;
      if (d.method === 'Efectivo') {
        const cover = Math.min(handed, cashRemaining);
        cashRemaining -= cover;
        const change = Math.min(cashChange, Math.max(0, handed - cover));
        cashChange -= change;
        payments.push({ method: 'Efectivo', amount: cover, billsPaid: null, changeGiven: change });
      } else {
        payments.push({ method: d.method, amount: handed, reference: d.reference || null });
      }
    }

    // Componer notes (fiado + factura)
    const noteParts: string[] = [];
    if (usingFiado) {
      const fiadoParts: string[] = [];
      if (fiadoName.trim())  fiadoParts.push(`Nombre:${fiadoName.trim()}`);
      const phone = fiadoPhone.replace(/\D/g, '');
      if (phone)             fiadoParts.push(`Tel:${phone}`);
      if (fiadoWhen.trim())  fiadoParts.push(`Pago:${fiadoWhen.trim()}`);
      if (fiadoParts.length) noteParts.push(`[FIADO] ${fiadoParts.join(' | ')}`);
    }
    if (invoice) {
      const wa = invWhats.replace(/\D/g, '');
      const facturaParts = [`WA:${wa}`, `Nombre:${invName.trim()}`];
      if (invDoc.trim())     facturaParts.push(`Doc:${invDoc.trim()}`);
      if (invEmail.trim())   facturaParts.push(`Correo:${invEmail.trim()}`);
      if (invAddress.trim()) facturaParts.push(`Direccion:${invAddress.trim()}`);
      noteParts.push(`[FACTURA] ${facturaParts.join(' | ')}`);
    } else {
      noteParts.push('[FACTURA] CONSUMIDOR_FINAL');
    }
    const notes = noteParts.join(' || ') || undefined;

    try { await onConfirm(payments, notes); }
    catch (e: any) { setError(e?.message || 'Error procesando venta'); setStep('payment'); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render por paso
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-3">
      <div className="bg-[#1E1E1E] border border-[#333] rounded-2xl w-full max-w-2xl max-h-[95vh] overflow-y-auto shadow-[0px_12px_40px_rgba(0,0,0,0.7)]">
        {/* Header con total enorme — siempre visible */}
        <div className="px-6 pt-5 pb-4 border-b border-[#2a2a2a] sticky top-0 bg-[#1E1E1E] z-10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[#8a9295] text-[11px] font-bold uppercase tracking-widest">Total a cobrar</div>
              <div className="text-white font-black text-4xl sm:text-5xl tracking-tight tabular-nums">{COP(total)}</div>
              {step === 'payment' && totals.remaining > 0 && totals.appliedToBill > 0 && (
                <div className="text-[#ffba27] text-xs font-semibold mt-1">
                  Falta: <span className="font-black">{COP(totals.remaining)}</span>
                </div>
              )}
              {step === 'payment' && totals.change > 0 && totals.remaining === 0 && (
                <div className="text-[#95d4b3] text-xs font-semibold mt-1">
                  Pago completo · vuelto: <span className="font-black">{COP(totals.change)}</span>
                </div>
              )}
            </div>
            <button onClick={onCancel} aria-label="Cerrar"
              className="text-[#8a9295] hover:text-white p-1.5 rounded-lg hover:bg-[#282a2b] shrink-0">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        <div className="p-5">
          {step === 'payment' && !canConfirmTransfers && (
            <div className="mb-4 flex items-start gap-2.5 bg-[#5d4000]/20 border border-[#ffba27]/40 rounded-xl px-3 py-2.5">
              <span className="material-symbols-outlined text-[#ffba27] text-[18px] mt-0.5 shrink-0">info</span>
              <p className="text-[#ffba27] text-xs leading-snug">
                Los pagos por transferencia bancaria deben ser confirmados por el administrador. Solo aparecen métodos que puedes verificar directamente.
              </p>
            </div>
          )}
          {step === 'payment' && (
            <PaymentStep
              total={total}
              availableMethods={availableMethods}
              drafts={drafts}
              setDrafts={setDrafts}
              combineMode={combineMode}
              setCombineMode={setCombineMode}
              allowMultiple={allowMultiple}
              totals={totals}
              pickExact={pickExact}
              pickCashReceived={pickCashReceived}
              updateDraft={updateDraft}
              removeDraft={removeDraft}
              addDraft={addDraft}
              fiadoName={fiadoName} setFiadoName={setFiadoName}
              fiadoPhone={fiadoPhone} setFiadoPhone={setFiadoPhone}
              fiadoWhen={fiadoWhen} setFiadoWhen={setFiadoWhen}
              usingFiado={usingFiado}
            />
          )}

          {step === 'invoice_ask' && (
            <InvoiceAskStep
              total={total}
              usingFiado={usingFiado}
              onYes={() => setStep('invoice_data')}
              onNo={() => submit(false)}
              loading={loading}
            />
          )}

          {step === 'invoice_data' && (
            <InvoiceDataStep
              wa={invWhats} setWa={setInvWhats}
              name={invName} setName={setInvName}
              doc={invDoc} setDoc={setInvDoc}
              email={invEmail} setEmail={setInvEmail}
              address={invAddress} setAddress={setInvAddress}
              err={invErr}
              onConfirm={() => submit(true)}
              onBack={() => setStep('invoice_ask')}
              loading={loading}
            />
          )}

          {error && <div className="mt-3 text-[#ffb4ab] text-sm bg-[#93000a]/30 border border-[#93000a] px-3 py-2 rounded-lg">{error}</div>}
        </div>

        {/* Footer del paso de pago */}
        {step === 'payment' && (
          <div className="px-5 pb-5 pt-1 border-t border-[#2a2a2a] sticky bottom-0 bg-[#1E1E1E]">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <button onClick={advanceToInvoice} disabled={!canConfirm || loading}
                className="h-14 bg-[#12533a] hover:bg-[#1a6b45] disabled:opacity-40 disabled:cursor-not-allowed text-[#95d4b3] font-black text-base rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
                <span className="material-symbols-outlined">arrow_forward</span>
                {loading ? 'Procesando…' : usingFiado ? 'Registrar fiado' : `Cobrar ${COP(total)}`}
              </button>
              <button onClick={onCancel}
                className="h-14 px-4 bg-[#1d2021] hover:bg-[#282a2b] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 1 — selección de pago
// ─────────────────────────────────────────────────────────────────────────────

interface PaymentStepProps {
  total: number;
  availableMethods: Method[];
  drafts: DraftPayment[];
  setDrafts: (updater: (ds: DraftPayment[]) => DraftPayment[]) => void;
  combineMode: boolean;
  setCombineMode: (v: boolean) => void;
  allowMultiple: boolean;
  totals: { appliedToBill: number; cashHandedIn: number; cashApplied: number; change: number; remaining: number };
  pickExact: (m: Method) => void;
  pickCashReceived: (received: number) => void;
  updateDraft: (idx: number, patch: Partial<DraftPayment>) => void;
  removeDraft: (idx: number) => void;
  addDraft: (methodName?: string) => void;
  fiadoName: string; setFiadoName: (s: string) => void;
  fiadoPhone: string; setFiadoPhone: (s: string) => void;
  fiadoWhen: string; setFiadoWhen: (s: string) => void;
  usingFiado: boolean;
}

function PaymentStep(props: PaymentStepProps) {
  const {
    total, availableMethods, drafts, setDrafts, combineMode, setCombineMode, allowMultiple,
    totals, pickExact, pickCashReceived, updateDraft, removeDraft,
    fiadoName, setFiadoName, fiadoPhone, setFiadoPhone, fiadoWhen, setFiadoWhen, usingFiado,
  } = props;

  // Ordenar para que efectivo aparezca primero (es el más usado en tienda).
  const ordered = [...availableMethods].sort((a, b) => {
    const score = (m: Method) => m.type === 'cash' ? 0 : m.type === 'fiado' ? 9 : 5;
    return score(a) - score(b);
  });

  const isSinglePayment = drafts.length === 1 && !combineMode;
  const primary = drafts[0];
  const primaryIsCash = primary?.method === 'Efectivo';
  const primaryIsFiado = primary?.method === 'Fiado';
  const primaryAmount = parseFloat(primary?.amount || '0') || 0;

  return (
    <div className="space-y-4">
      {/* Tiles grandes — un tap basta */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[#8a9295] text-[11px] font-bold uppercase tracking-widest">Método de pago</span>
          {allowMultiple && (
            <button onClick={() => setCombineMode(!combineMode)}
              className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md transition-colors ${
                combineMode ? 'bg-[#0f4c5c] text-[#9acee1]' : 'bg-[#282a2b] text-[#8a9295] hover:text-[#9acee1]'
              }`}>
              {combineMode ? '✓ Pago mixto' : '+ Combinar métodos'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {ordered.map(m => {
            const t = methodTheme(m.type, m.name);
            const selected = isSinglePayment && primary.method === m.name && Math.abs(primaryAmount - total) < 0.01;
            return (
              <button key={m.name} onClick={() => pickExact(m)}
                className={`relative h-20 rounded-xl ${t.bg} ${t.hov} text-white font-black flex flex-col items-center justify-center gap-1 transition-all active:scale-[0.97] ${
                  selected ? `ring-2 ${t.ring}` : ''
                }`}>
                <span className={`material-symbols-outlined text-[26px] ${t.txt}`}>{m.icon}</span>
                <span className="text-xs uppercase tracking-wider">{m.name}</span>
                {selected && (
                  <span className="absolute top-1.5 right-1.5 material-symbols-outlined text-[16px] text-white bg-black/40 rounded-full">check_circle</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Modo simple — efectivo: botones de billete recibido */}
      {isSinglePayment && primaryIsCash && (
        <div className="bg-[#121212] border border-[#12533a]/40 rounded-xl p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[#95d4b3] text-[11px] font-bold uppercase tracking-widest">¿Cuánto recibió el cliente?</span>
            <button onClick={() => pickCashReceived(total)}
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-[#12533a]/40 text-[#95d4b3] hover:bg-[#12533a]/70">
              Pago exacto
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {QUICK_BILLS.filter(b => b >= total).slice(0, 6).map(b => (
              <button key={b} onClick={() => pickCashReceived(b)}
                className={`h-14 rounded-xl border-2 font-black text-base transition-all active:scale-[0.97] ${
                  Math.abs(primaryAmount - b) < 0.01
                    ? 'bg-[#12533a] border-[#95d4b3] text-white'
                    : 'bg-[#121212] border-[#2a2a2a] text-[#c0c8cb] hover:border-[#95d4b3]'
                }`}>
                {COP(b)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#8a9295] text-xs shrink-0">Otro:</span>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8a9295] text-sm">$</span>
              <input type="number" value={primary.amount}
                onChange={e => updateDraft(0, { amount: e.target.value })}
                placeholder="Monto recibido"
                className="w-full pl-7 pr-3 py-2.5 rounded-lg bg-[#1E1E1E] border border-[#2a2a2a] text-[#95d4b3] text-base font-bold focus:border-[#95d4b3] outline-none" />
            </div>
          </div>

          {/* Vuelto enorme */}
          {totals.change > 0 && (
            <div className="rounded-xl bg-gradient-to-br from-[#12533a] to-[#0c4029] border border-[#95d4b3]/40 p-4 text-center">
              <div className="text-[#95d4b3] text-[10px] font-bold uppercase tracking-widest">Vuelto a entregar</div>
              <div className="text-white font-black text-4xl sm:text-5xl tabular-nums leading-tight mt-1">{COP(totals.change)}</div>
            </div>
          )}
          {totals.remaining > 0 && primaryAmount > 0 && (
            <div className="text-[#ffb4ab] text-xs text-center font-semibold">
              Falta {COP(totals.remaining)} para completar
            </div>
          )}
        </div>
      )}

      {/* Modo simple — no efectivo y no fiado: opcional referencia */}
      {isSinglePayment && !primaryIsCash && !primaryIsFiado && (
        <div className="bg-[#121212] border border-[#0f4c5c]/40 rounded-xl p-3">
          <input type="text" value={primary.reference || ''}
            onChange={e => updateDraft(0, { reference: e.target.value })}
            placeholder="Ref. de transferencia (opcional)"
            className="w-full bg-[#1E1E1E] border border-[#2a2a2a] rounded-lg px-3 py-2 text-[#c0c8cb] text-sm" />
        </div>
      )}

      {/* Modo simple — fiado: datos del cliente (nombre + teléfono separados) */}
      {isSinglePayment && primaryIsFiado && (
        <FiadoFields
          name={fiadoName} setName={setFiadoName}
          phone={fiadoPhone} setPhone={setFiadoPhone}
          when={fiadoWhen} setWhen={setFiadoWhen}
        />
      )}

      {/* Modo combinar — tiles clickables (sin select dropdown) */}
      {combineMode && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Pagado" value={COP(totals.appliedToBill)} color={totals.remaining === 0 ? 'text-[#95d4b3]' : 'text-[#e1e2e4]'} />
            <Stat label="Falta"  value={COP(totals.remaining)}     color={totals.remaining > 0 ? 'text-[#ffb4ab]' : 'text-[#8a9295]'} />
            <Stat label="Vuelto" value={COP(totals.change)}        color={totals.change > 0 ? 'text-[#ffba27]' : 'text-[#8a9295]'} />
          </div>

          {/* Tiles: cada uno actúa como toggle. Si se activa, se agrega como draft con el monto restante. */}
          <div>
            <p className="text-[#8a9295] text-[10px] font-bold uppercase tracking-widest mb-1.5">Toca un método para añadirlo</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ordered.map(m => {
                const t = methodTheme(m.type, m.name);
                const draftIdx = drafts.findIndex(d => d.method === m.name);
                const active = draftIdx >= 0;
                const amount = active ? parseFloat(drafts[draftIdx].amount) || 0 : 0;
                return (
                  <button key={m.name}
                    onClick={() => {
                      if (active) {
                        // Si ya está y hay más de 1 método activo, lo quita. Si es el único, no hace nada.
                        if (drafts.length > 1) removeDraft(draftIdx);
                      } else {
                        const remaining = Math.max(0, total - totals.appliedToBill);
                        setDrafts(ds => [...ds, { method: m.name, amount: remaining > 0 ? String(remaining) : '' }]);
                      }
                    }}
                    className={`relative h-16 rounded-xl ${t.bg} ${t.hov} text-white font-bold flex flex-col items-center justify-center gap-0.5 transition-all active:scale-[0.97] ${active ? `ring-2 ${t.ring}` : 'opacity-70'}`}>
                    <span className={`material-symbols-outlined text-[20px] ${t.txt}`}>{m.icon}</span>
                    <span className="text-[10px] uppercase tracking-wider">{m.name}</span>
                    {active && (
                      <span className="absolute top-1 right-1 material-symbols-outlined text-[14px] text-white bg-black/40 rounded-full">check_circle</span>
                    )}
                    {active && amount > 0 && (
                      <span className="absolute bottom-1 right-1.5 text-[9px] font-black text-white bg-black/40 px-1 rounded">{COP(amount)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Inputs de monto por método activo */}
          <div className="space-y-2">
            {drafts.map((d, i) => {
              const isCash = d.method === 'Efectivo';
              const isFiado = d.method === 'Fiado';
              const meta = availableMethods.find(m => m.name === d.method);
              const t = methodTheme(meta?.type || 'other', d.method);
              return (
                <div key={i} className="bg-[#121212] border border-[#2a2a2a] rounded-xl p-2.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`material-symbols-outlined text-[16px] ${t.txt}`}>{meta?.icon || 'payment'}</span>
                    <span className="text-[#c0c8cb] text-xs font-bold flex-1">{d.method}</span>
                    {drafts.length > 1 && (
                      <button onClick={() => removeDraft(i)}
                        className="text-[#8a9295] hover:text-[#ffb4ab] p-1 rounded hover:bg-[#93000a]/20">
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8a9295] text-sm">$</span>
                    <input type="number" value={d.amount}
                      onChange={e => updateDraft(i, { amount: e.target.value })}
                      placeholder={isFiado ? 'Monto fiado' : 'Monto'}
                      className={`w-full pl-7 pr-3 py-2.5 rounded-lg border text-base font-bold text-center ${
                        isCash ? 'bg-[#1E1E1E] border-[#12533a] text-[#95d4b3]'
                        : isFiado ? 'bg-[#1E1E1E] border-[#5d4000] text-[#ffba27]'
                        : 'bg-[#1E1E1E] border-[#0f4c5c] text-[#9acee1]'
                      }`} />
                  </div>
                  {!isCash && !isFiado && (
                    <input type="text" value={d.reference || ''}
                      onChange={e => updateDraft(i, { reference: e.target.value })}
                      placeholder="Ref. de transferencia (opcional)"
                      className="mt-1.5 w-full bg-[#1E1E1E] border border-[#333] rounded-lg px-3 py-2 text-[#c0c8cb] text-xs" />
                  )}
                </div>
              );
            })}
          </div>

          {usingFiado && (
            <FiadoFields
              name={fiadoName} setName={setFiadoName}
              phone={fiadoPhone} setPhone={setFiadoPhone}
              when={fiadoWhen} setWhen={setFiadoWhen}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FiadoFields({
  name, setName, phone, setPhone, when, setWhen,
}: {
  name: string; setName: (s: string) => void;
  phone: string; setPhone: (s: string) => void;
  when: string; setWhen: (s: string) => void;
}) {
  return (
    <div className="bg-[#5d4000]/20 border border-[#ffba27]/30 rounded-xl p-3 space-y-2">
      <p className="text-[#ffba27] text-[11px] font-bold uppercase tracking-widest">Datos del cliente (fiado)</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <span className="block text-[10px] text-[#ffba27]/80 font-bold uppercase tracking-wider mb-1">Nombre <span className="text-[#ffb4ab]">*</span></span>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="Ej: Juan Pérez"
            autoFocus
            className="w-full bg-[#121212] border border-[#5d4000] rounded-lg px-3 py-2 text-[#e1e2e4] text-sm focus:border-[#ffba27] outline-none" />
        </div>
        <div>
          <span className="block text-[10px] text-[#ffba27]/80 font-bold uppercase tracking-wider mb-1">Teléfono</span>
          <input type="tel" inputMode="numeric" value={phone}
            onChange={e => setPhone(e.target.value.replace(/[^\d\s+()-]/g, ''))}
            placeholder="Ej: 300 123 4567"
            className="w-full bg-[#121212] border border-[#5d4000] rounded-lg px-3 py-2 text-[#e1e2e4] text-sm focus:border-[#ffba27] outline-none" />
        </div>
      </div>
      <div>
        <span className="block text-[10px] text-[#ffba27]/80 font-bold uppercase tracking-wider mb-1">¿Cuándo paga?</span>
        <input type="text" value={when} onChange={e => setWhen(e.target.value)}
          placeholder="Ej: Viernes, fin de mes…"
          className="w-full bg-[#121212] border border-[#5d4000] rounded-lg px-3 py-2 text-[#e1e2e4] text-sm focus:border-[#ffba27] outline-none" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 2 — ¿Desea factura?
// ─────────────────────────────────────────────────────────────────────────────

function InvoiceAskStep({ total, usingFiado, onYes, onNo, loading }: { total: number; usingFiado: boolean; onYes: () => void; onNo: () => void; loading: boolean }) {
  const noBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { noBtnRef.current?.focus(); }, []);

  return (
    <div className="space-y-4 py-2">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#0f4c5c]/40 mb-3">
          <span className="material-symbols-outlined text-[#9acee1] text-3xl">receipt_long</span>
        </div>
        <h3 className="text-white font-black text-2xl">¿Desea factura?</h3>
        <p className="text-[#8a9295] text-sm mt-1">
          {usingFiado
            ? <>Venta registrada por <span className="text-[#ffba27] font-bold">{COP(total)}</span> · incluye fiado</>
            : <>Cobro completado por <span className="text-[#95d4b3] font-bold">{COP(total)}</span></>}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button ref={noBtnRef}
          onClick={onNo} disabled={loading}
          onKeyDown={e => { if (e.key === 'Enter') onNo(); }}
          className="h-24 bg-[#1d2021] hover:bg-[#282a2b] border-2 border-[#333] hover:border-[#c0c8cb] disabled:opacity-40 text-white font-black text-xl rounded-xl transition-all active:scale-[0.98] flex flex-col items-center justify-center gap-1">
          <span className="material-symbols-outlined text-[28px]">close</span>
          NO
          <span className="text-[10px] font-medium text-[#8a9295] tracking-wider uppercase">Consumidor final</span>
        </button>
        <button onClick={onYes} disabled={loading}
          className="h-24 bg-[#0f4c5c] hover:bg-[#155a6d] border-2 border-[#9acee1] disabled:opacity-40 text-white font-black text-xl rounded-xl transition-all active:scale-[0.98] flex flex-col items-center justify-center gap-1">
          <span className="material-symbols-outlined text-[28px] text-[#9acee1]">receipt_long</span>
          SÍ
          <span className="text-[10px] font-medium text-[#9acee1] tracking-wider uppercase">Pedir datos</span>
        </button>
      </div>

      <p className="text-[#40484b] text-[11px] text-center">
        Pulsa <kbd className="px-1.5 py-0.5 bg-[#282a2b] rounded text-[#c0c8cb] font-mono">Enter</kbd> para registrar como consumidor final y seguir vendiendo.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 3 — Datos del cliente para la factura
// ─────────────────────────────────────────────────────────────────────────────

function InvoiceDataStep(props: {
  wa: string; setWa: (s: string) => void;
  name: string; setName: (s: string) => void;
  doc: string; setDoc: (s: string) => void;
  email: string; setEmail: (s: string) => void;
  address: string; setAddress: (s: string) => void;
  err: string;
  onConfirm: () => void;
  onBack: () => void;
  loading: boolean;
}) {
  const { wa, setWa, name, setName, doc, setDoc, email, setEmail, address, setAddress, err, onConfirm, onBack, loading } = props;
  const waRef = useRef<HTMLInputElement>(null);
  useEffect(() => { waRef.current?.focus(); }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-[#8a9295] hover:text-white p-1 rounded-lg hover:bg-[#282a2b]">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h3 className="text-white font-bold text-lg">Datos para la factura</h3>
          <p className="text-[#8a9295] text-xs">Se enviará al WhatsApp del cliente.</p>
        </div>
      </div>

      <Field label="WhatsApp" required hint="Para enviar la factura electrónica">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[#95d4b3] text-[20px]">chat</span>
          <input ref={waRef} type="tel" inputMode="numeric" value={wa}
            onChange={e => setWa(e.target.value.replace(/[^\d\s+()-]/g, ''))}
            placeholder="Ej: 300 123 4567"
            className="w-full pl-11 pr-3 py-3 bg-[#121212] border border-[#12533a] rounded-xl text-white text-base font-semibold focus:border-[#95d4b3] outline-none" />
        </div>
      </Field>

      <Field label="Nombre del cliente" required>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="Ej: Juan Pérez"
          className="w-full px-3 py-2.5 bg-[#121212] border border-[#333] rounded-xl text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none" />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="NIT / Cédula" hint="Opcional">
          <input type="text" value={doc} onChange={e => setDoc(e.target.value)}
            placeholder="123.456.789"
            className="w-full px-3 py-2.5 bg-[#121212] border border-[#333] rounded-xl text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none" />
        </Field>
        <Field label="Correo" hint="Opcional">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="cliente@correo.com"
            className="w-full px-3 py-2.5 bg-[#121212] border border-[#333] rounded-xl text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none" />
        </Field>
      </div>

      <Field label="Dirección" hint="Opcional — útil para domicilios y facturación física">
        <input type="text" value={address} onChange={e => setAddress(e.target.value)}
          placeholder="Ej: Cra 123 #45-67, Bogotá"
          className="w-full px-3 py-2.5 bg-[#121212] border border-[#333] rounded-xl text-[#e1e2e4] text-sm focus:border-[#9acee1] outline-none" />
      </Field>

      {err && <div className="text-[#ffb4ab] text-xs bg-[#93000a]/30 border border-[#93000a]/50 px-3 py-2 rounded-lg">{err}</div>}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <button onClick={onConfirm} disabled={loading}
          className="h-12 bg-[#12533a] hover:bg-[#1a6b45] disabled:opacity-40 text-[#95d4b3] font-black rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
          <span className="material-symbols-outlined">check_circle</span>
          {loading ? 'Procesando…' : 'Emitir factura'}
        </button>
        <button onClick={onBack}
          className="h-12 bg-[#1d2021] hover:bg-[#282a2b] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl transition-colors">
          Atrás
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ─────────────────────────────────────────────────────────────────────────────

function Stat({ label, value, color = 'text-[#e1e2e4]' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#121212] border border-[#2a2a2a] rounded-xl p-2.5">
      <p className="text-[#8a9295] text-[10px] font-bold uppercase tracking-wider">{label}</p>
      <p className={`font-black text-base tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-[#8a9295] font-bold uppercase tracking-widest mb-1">
        {label} {required && <span className="text-[#ffb4ab]">*</span>}
        {hint && <span className="text-[#40484b] normal-case font-medium tracking-normal ml-1.5">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}
