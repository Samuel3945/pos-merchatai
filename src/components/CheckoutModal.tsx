import { useEffect, useMemo, useRef, useState } from 'react';
import { PaymentMethod, SalePayment } from '../services/api';
import { DueDateCalendar } from './DueDateCalendar';

const COP = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('es-CO')}`;

// Denominaciones más comunes que un cliente entrega en Colombia.
const QUICK_BILLS = [2000, 5000, 10000, 20000, 50000, 100000];

// Local-time YYYY-MM-DD for a date `days` from today. Used for credit due dates
// (the structured value sent to the backend, which the server stores verbatim).
const isoDaysFromNow = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Human label for a YYYY-MM-DD due date, e.g. "viernes, 1 de agosto".
const dueDateLabel = (iso: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(y, m - 1, d));
};

type Method = { name: string; icon: string; type: string; subtitle?: string };

type DraftPayment = {
  method: string;
  amount: string;
  reference?: string;
};

type Step = 'payment' | 'invoice_ask' | 'invoice_data';

interface Props {
  total: number;
  paymentMethods: PaymentMethod[];
  creditoEnabled: boolean;
  // Operator-gated DIAN e-invoicing. When false the checkout never shows the
  // "¿Desea factura?" step — the sale closes as a normal POS sale.
  einvoiceEnabled?: boolean;
  canConfirmTransfers?: boolean;
  // Plazo de pago por defecto del negocio (días). El backend asigna el
  // vencimiento real con este mismo valor al crear el credito.
  creditoTermDays?: number;
  // 'sale' (default): full charge flow, ends in the invoice question.
  // 'correction': re-enter the method split of an EXISTING sale. Same total,
  // no invoice step, no credito (correcting a credito would desync its ledger).
  // The split is pre-loaded from `initialPayments` and confirming calls
  // onConfirm directly with the new breakdown.
  mode?: 'sale' | 'correction';
  initialPayments?: SalePayment[];
  onConfirm: (payments: SalePayment[], notes?: string, dueDate?: string | null) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos compartidos por método (tinte suave + acento, theme-aware via tokens)
// ─────────────────────────────────────────────────────────────────────────────

// Métodos de transferencia: el unificado 'transfer' y los legacy 'nequi'/'llave'.
// Cada cuenta se muestra como su propio botón con el nombre que le puso el admin
// (ej. "Nequi Samuel") y el número de cuenta destino, para que la venta registre
// A QUÉ cuenta entró la plata. Tesorería atribuye el depósito matcheando ese
// nombre, así que cada método debe tener un nombre distinto.
function isTransferType(type: string) {
  return type === 'transfer' || type === 'nequi' || type === 'llave';
}

// Fiado/credito is ALWAYS shown as a single synthetic tile (handshake, type
// 'credito') driven by the creditoEnabled flag. Any configured method that is
// really credito — the seeded "Crédito" (type 'credit'), an accented name, or
// 'fiado' — is filtered out so it never shows up as a second, transfer-like tile.
function isCreditoLike(pm: { type: string; name: string }): boolean {
  if (pm.type === 'credito' || pm.type === 'credit') return true;
  return /cr[ée]dito|fiado/i.test(pm.name);
}

function methodTheme(type: string, _name: string) {
  if (type === 'cash')   return { soft: 'bg-success-soft', txt: 'text-success', ring: 'ring-success', border: 'border-success' };
  if (type === 'credito')  return { soft: 'bg-warn-soft',    txt: 'text-warn',    ring: 'ring-warn',    border: 'border-warn' };
  if (type === 'card')   return { soft: 'bg-info-soft',    txt: 'text-info',    ring: 'ring-info',    border: 'border-info' };
  // 'transfer' (y cualquier otro tipo) → tema primary.
  return { soft: 'bg-primary-soft', txt: 'text-primary', ring: 'ring-primary', border: 'border-primary' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal principal
// ─────────────────────────────────────────────────────────────────────────────

export default function CheckoutModal({ total, paymentMethods, creditoEnabled, einvoiceEnabled = false, canConfirmTransfers = true, creditoTermDays = 30, mode = 'sale', initialPayments, onConfirm, onCancel, loading }: Props) {
  const isCorrection = mode === 'correction';
  const availableMethods = useMemo<Method[]>(() => {
    const list: Method[] = [];
    const activeCustom = paymentMethods.filter(pm => pm.active && !isCreditoLike(pm));
    for (const pm of activeCustom) {
      // Cuentas de transferencia: una por método, con su número de cuenta debajo.
      // Solo se muestran si el cajero tiene permiso para confirmarlas.
      if (isTransferType(pm.type)) {
        if (!canConfirmTransfers) continue;
        list.push({
          name: pm.name,
          icon: pm.icon || 'account_balance',
          type: pm.type,
          subtitle: pm.details?.account_number || undefined,
        });
        continue;
      }
      list.push({ name: pm.name, icon: pm.icon || 'payment', type: pm.type });
    }
    // Efectivo siempre disponible — es el medio de pago universal en tienda de barrio.
    if (!list.find(m => m.name === 'Efectivo' || m.type === 'cash')) {
      list.unshift({ name: 'Efectivo', icon: 'payments', type: 'cash' });
    }
    if (creditoEnabled && !list.find(m => m.type === 'credito')) {
      list.push({ name: 'Credito', icon: 'handshake', type: 'credito' });
    }
    return list;
  }, [paymentMethods, creditoEnabled, canConfirmTransfers]);

  const allowMultiple = availableMethods.length > 1;

  const [step, setStep] = useState<Step>('payment');
  const [drafts, setDrafts] = useState<DraftPayment[]>(() => {
    // In correction mode, start from the sale's CURRENT split so the cashier
    // edits what's there instead of re-typing from scratch.
    if (isCorrection && initialPayments && initialPayments.length > 0) {
      return initialPayments.map(p => ({
        method: p.method,
        // A cash draft holds what the customer HANDED IN (applied + change), so
        // the change calculator reconstructs the same vuelto for rows the cashier
        // leaves untouched.
        amount: String(
          p.method === 'Efectivo'
            ? Number(p.amount) + Number(p.changeGiven ?? 0)
            : p.amount,
        ),
        reference: p.reference ?? undefined,
      }));
    }
    return [{ method: 'Efectivo', amount: String(total) }];
  });
  const [combineMode, setCombineMode] = useState(
    isCorrection && (initialPayments?.length ?? 0) > 1,
  );
  const [creditoName, setCreditoName] = useState('');
  const [creditoPhone, setCreditoPhone] = useState('');
  // Structured credit due date (YYYY-MM-DD). Defaults to the business term but the
  // cashier can change it with the calendar / quick presets in CreditoFields.
  const [creditoDueDate, setCreditoDueDate] = useState(() => isoDaysFromNow(creditoTermDays));
  const [error, setError] = useState('');

  // Datos de factura
  const [invWhats, setInvWhats] = useState('');
  const [invName, setInvName] = useState('');
  const [invDoc, setInvDoc] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [invAddress, setInvAddress] = useState('');
  const [invErr, setInvErr] = useState('');

  // Sincroniza el primer draft cuando los métodos llegan tarde. En modo
  // corrección la precarga manda — no la pisamos aunque un método haya sido
  // renombrado/desactivado desde la venta.
  useEffect(() => {
    if (isCorrection) return;
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
  const usingCredito = drafts.some(d => d.method === 'Credito');

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
    // Validar datos de credito antes de avanzar para no perderlos en el paso siguiente.
    if (usingCredito && !creditoName.trim()) {
      setError('El nombre del cliente es obligatorio para registrar el crédito');
      return;
    }
    // E-invoicing hidden for this org → skip the "¿Desea factura?" step and close
    // the sale as a normal POS sale (final consumer).
    if (!einvoiceEnabled) { void submit(false); return; }
    setStep('invoice_ask');
  };

  // Arma el array de pagos a partir de los drafts: el efectivo aporta solo lo
  // que cubre la cuenta (el resto es vuelto), los demás métodos su monto entero.
  const buildPayments = (): SalePayment[] => {
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
    return payments;
  };

  // Correction: apply the new split to an existing sale. No invoice step. If the
  // correction turns part of the sale into fiado, the customer becomes a debtor,
  // so we require their name and pass the [CREDITO] note so the backend books the
  // debt. Otherwise notes stay untouched.
  const submitCorrection = async () => {
    setError('');
    if (totals.remaining > 0) { setError(`Faltan ${COP(totals.remaining)} por cubrir el total`); return; }
    if (usingCredito && !creditoName.trim()) {
      setError('El nombre del cliente es obligatorio para registrar el crédito');
      return;
    }
    let notes: string | undefined;
    if (usingCredito) {
      const parts: string[] = [];
      if (creditoName.trim()) parts.push(`Nombre:${creditoName.trim()}`);
      const phone = creditoPhone.replace(/\D/g, '');
      if (phone) parts.push(`Tel:${phone}`);
      if (creditoDueDate) parts.push(`Pago:${dueDateLabel(creditoDueDate)}`);
      if (parts.length) notes = `[CREDITO] ${parts.join(' | ')}`;
    }
    try { await onConfirm(buildPayments(), notes, usingCredito ? creditoDueDate : undefined); }
    catch (e: any) { setError(e?.message || 'No se pudo guardar la corrección'); }
  };

  const submit = async (invoice: boolean) => {
    setError(''); setInvErr('');
    if (usingCredito && !creditoName.trim()) {
      setError('El nombre del cliente es obligatorio para registrar el crédito');
      return;
    }
    if (invoice) {
      const wa = invWhats.replace(/\D/g, '');
      if (wa.length < 7) { setInvErr('El WhatsApp es obligatorio para enviar la factura'); return; }
      if (!invName.trim()) { setInvErr('El nombre del cliente es obligatorio'); return; }
    }

    const payments = buildPayments();

    // Componer notes (credito + factura)
    const noteParts: string[] = [];
    if (usingCredito) {
      const creditoParts: string[] = [];
      if (creditoName.trim())  creditoParts.push(`Nombre:${creditoName.trim()}`);
      const phone = creditoPhone.replace(/\D/g, '');
      if (phone)             creditoParts.push(`Tel:${phone}`);
      if (creditoDueDate)  creditoParts.push(`Pago:${dueDateLabel(creditoDueDate)}`);
      if (creditoParts.length) noteParts.push(`[CREDITO] ${creditoParts.join(' | ')}`);
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

    try { await onConfirm(payments, notes, usingCredito ? creditoDueDate : undefined); }
    catch (e: any) { setError(e?.message || 'Error procesando venta'); setStep('payment'); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render por paso
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50 p-3">
      <div className="bg-surface border border-line rounded-[22px] w-full max-w-2xl max-h-[95vh] overflow-y-auto shadow-token3">
        {/* Header con total enorme — siempre visible */}
        <div className="px-6 pt-5 pb-4 border-b border-line sticky top-0 bg-surface z-10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-ink-3 text-[11px] font-bold uppercase tracking-widest">{isCorrection ? 'Total de la venta' : 'Total a cobrar'}</div>
              <div className="font-display font-semibold text-4xl sm:text-5xl tracking-tight tnum">{COP(total)}</div>
              {step === 'payment' && totals.remaining > 0 && totals.appliedToBill > 0 && (
                <div className="text-warn text-xs font-semibold mt-1">
                  Falta: <span className="font-extrabold">{COP(totals.remaining)}</span>
                </div>
              )}
              {step === 'payment' && totals.change > 0 && totals.remaining === 0 && (
                <div className="text-success text-xs font-semibold mt-1">
                  Pago completo · vuelto: <span className="font-extrabold">{COP(totals.change)}</span>
                </div>
              )}
            </div>
            <button onClick={onCancel} aria-label="Cerrar"
              className="text-ink-3 hover:text-ink p-1.5 rounded-lg hover:bg-surface-2 shrink-0">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        <div className="p-5">
          {step === 'payment' && !canConfirmTransfers && (
            <div className="mb-4 flex items-start gap-2.5 bg-warn-soft border border-warn/40 rounded-xl px-3 py-2.5">
              <span className="material-symbols-outlined text-warn text-[18px] mt-0.5 shrink-0">info</span>
              <p className="text-warn text-xs leading-snug">
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
              creditoName={creditoName} setCreditoName={setCreditoName}
              creditoPhone={creditoPhone} setCreditoPhone={setCreditoPhone}
              creditoDueDate={creditoDueDate} setCreditoDueDate={setCreditoDueDate}
              usingCredito={usingCredito}
            />
          )}

          {step === 'invoice_ask' && (
            <InvoiceAskStep
              total={total}
              usingCredito={usingCredito}
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

          {error && <div className="mt-3 text-danger text-sm bg-danger-soft border border-danger/50 px-3 py-2 rounded-lg">{error}</div>}
        </div>

        {/* Footer del paso de pago */}
        {step === 'payment' && (
          <div className="px-5 pb-5 pt-1 border-t border-line sticky bottom-0 bg-surface">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <button onClick={isCorrection ? submitCorrection : advanceToInvoice} disabled={!canConfirm || loading}
                className="h-14 bg-primary hover:bg-primary-ink disabled:opacity-45 disabled:cursor-not-allowed text-white font-bold text-base rounded-2xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
                <span className="material-symbols-outlined">{isCorrection ? 'save' : 'arrow_forward'}</span>
                {loading ? 'Procesando…' : isCorrection ? 'Guardar corrección' : usingCredito ? 'Registrar crédito' : `Cobrar ${COP(total)}`}
              </button>
              <button onClick={onCancel}
                className="h-14 px-4 bg-surface-2 hover:bg-surface-3 border border-line text-ink-2 font-semibold rounded-2xl transition-colors">
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
  creditoName: string; setCreditoName: (s: string) => void;
  creditoPhone: string; setCreditoPhone: (s: string) => void;
  creditoDueDate: string; setCreditoDueDate: (s: string) => void;
  usingCredito: boolean;
}

function PaymentStep(props: PaymentStepProps) {
  const {
    total, availableMethods, drafts, setDrafts, combineMode, setCombineMode, allowMultiple,
    totals, pickExact, pickCashReceived, updateDraft, removeDraft,
    creditoName, setCreditoName, creditoPhone, setCreditoPhone, creditoDueDate, setCreditoDueDate, usingCredito,
  } = props;

  // Ordenar para que efectivo aparezca primero (es el más usado en tienda).
  const ordered = [...availableMethods].sort((a, b) => {
    const score = (m: Method) => m.type === 'cash' ? 0 : m.type === 'credito' ? 9 : 5;
    return score(a) - score(b);
  });

  const isSinglePayment = drafts.length === 1 && !combineMode;
  const primary = drafts[0];
  const primaryIsCash = primary?.method === 'Efectivo';
  const primaryIsCredito = primary?.method === 'Credito';
  const primaryAmount = parseFloat(primary?.amount || '0') || 0;

  return (
    <div className="space-y-4">
      {/* Tiles grandes — un tap basta */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-ink-3 text-[11px] font-bold uppercase tracking-widest">Método de pago</span>
          {allowMultiple && (
            <button onClick={() => setCombineMode(!combineMode)}
              className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md transition-colors ${
                combineMode ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-3 hover:text-primary'
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
                className={`relative h-20 rounded-xl ${t.soft} border flex flex-col items-center justify-center gap-0.5 px-1 transition-all active:scale-[0.97] ${
                  selected ? `${t.border} ring-2 ${t.ring}` : 'border-line'
                }`}>
                <span className={`material-symbols-outlined text-[24px] ${t.txt}`}>{m.icon}</span>
                <span className="w-full text-center text-xs font-bold uppercase tracking-wider truncate text-ink">{m.name}</span>
                {m.subtitle && (
                  <span className="w-full text-center text-[10px] font-semibold text-ink-3 tnum truncate">{m.subtitle}</span>
                )}
                {selected && (
                  <span className={`absolute top-1.5 right-1.5 material-symbols-outlined text-[16px] ${t.txt}`}>check_circle</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Modo simple — efectivo: botones de billete recibido */}
      {isSinglePayment && primaryIsCash && (
        <div className="bg-surface-2 border border-success/40 rounded-xl p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-success text-[11px] font-bold uppercase tracking-widest">¿Cuánto recibió el cliente?</span>
            <button onClick={() => pickCashReceived(total)}
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-success-soft text-success hover:opacity-80">
              Pago exacto
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {QUICK_BILLS.filter(b => b >= total).slice(0, 6).map(b => (
              <button key={b} onClick={() => pickCashReceived(b)}
                className={`h-14 rounded-xl border-2 font-extrabold text-base transition-all active:scale-[0.97] tnum ${
                  Math.abs(primaryAmount - b) < 0.01
                    ? 'bg-success-soft border-success text-success'
                    : 'bg-surface border-line text-ink-2 hover:border-success'
                }`}>
                {COP(b)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-ink-3 text-xs shrink-0">Otro:</span>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-sm">$</span>
              <input type="number" value={primary.amount}
                onChange={e => updateDraft(0, { amount: e.target.value })}
                placeholder="Monto recibido"
                className="w-full pl-7 pr-3 py-2.5 rounded-lg bg-surface border border-line text-success text-base font-bold focus:border-success outline-none" />
            </div>
          </div>

          {/* Vuelto enorme */}
          {totals.change > 0 && (
            <div className="rounded-xl bg-success-soft border border-success/40 p-4 text-center">
              <div className="text-success text-[10px] font-bold uppercase tracking-widest">Vuelto a entregar</div>
              <div className="font-display font-semibold text-4xl sm:text-5xl tnum leading-tight mt-1">{COP(totals.change)}</div>
            </div>
          )}
          {totals.remaining > 0 && primaryAmount > 0 && (
            <div className="text-danger text-xs text-center font-semibold">
              Falta {COP(totals.remaining)} para completar
            </div>
          )}
        </div>
      )}

      {/* Modo simple — no efectivo y no credito: opcional referencia */}
      {isSinglePayment && !primaryIsCash && !primaryIsCredito && (
        <div className="bg-surface-2 border border-primary/40 rounded-xl p-3">
          <input type="text" value={primary.reference || ''}
            onChange={e => updateDraft(0, { reference: e.target.value })}
            placeholder="Ref. de transferencia (opcional)"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink-2 text-sm focus:border-primary outline-none" />
        </div>
      )}

      {/* Modo simple — credito: datos del cliente (nombre + teléfono separados) */}
      {isSinglePayment && primaryIsCredito && (
        <CreditoFields
          name={creditoName} setName={setCreditoName}
          phone={creditoPhone} setPhone={setCreditoPhone}
          dueDate={creditoDueDate} setDueDate={setCreditoDueDate}
        />
      )}

      {/* Modo combinar — tiles clickables (sin select dropdown) */}
      {combineMode && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Pagado" value={COP(totals.appliedToBill)} color={totals.remaining === 0 ? 'text-success' : 'text-ink'} />
            <Stat label="Falta"  value={COP(totals.remaining)}     color={totals.remaining > 0 ? 'text-danger' : 'text-ink-3'} />
            <Stat label="Vuelto" value={COP(totals.change)}        color={totals.change > 0 ? 'text-warn' : 'text-ink-3'} />
          </div>

          {/* Tiles: cada uno actúa como toggle. Si se activa, se agrega como draft con el monto restante. */}
          <div>
            <p className="text-ink-3 text-[10px] font-bold uppercase tracking-widest mb-1.5">Toca un método para añadirlo</p>
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
                    className={`relative h-16 rounded-xl ${t.soft} border flex flex-col items-center justify-center gap-0.5 transition-all active:scale-[0.97] ${active ? `${t.border} ring-2 ${t.ring}` : 'border-line opacity-70'}`}>
                    <span className={`material-symbols-outlined text-[20px] ${t.txt}`}>{m.icon}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink">{m.name}</span>
                    {active && (
                      <span className={`absolute top-1 right-1 material-symbols-outlined text-[14px] ${t.txt}`}>check_circle</span>
                    )}
                    {active && amount > 0 && (
                      <span className="absolute bottom-1 right-1.5 text-[9px] font-extrabold text-ink bg-surface-3 px-1 rounded tnum">{COP(amount)}</span>
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
              const isCredito = d.method === 'Credito';
              const meta = availableMethods.find(m => m.name === d.method);
              const t = methodTheme(meta?.type || 'other', d.method);
              return (
                <div key={i} className="bg-surface-2 border border-line rounded-xl p-2.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`material-symbols-outlined text-[16px] ${t.txt}`}>{meta?.icon || 'payment'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-ink-2 text-xs font-bold truncate">{d.method}</span>
                      {meta?.subtitle && (
                        <span className="block text-ink-3 text-[10px] font-semibold tnum truncate">{meta.subtitle}</span>
                      )}
                    </span>
                    {drafts.length > 1 && (
                      <button onClick={() => removeDraft(i)}
                        className="text-ink-3 hover:text-danger p-1 rounded hover:bg-danger-soft">
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-sm">$</span>
                    <input type="number" value={d.amount}
                      onChange={e => updateDraft(i, { amount: e.target.value })}
                      placeholder={isCredito ? 'Monto crédito' : 'Monto'}
                      className={`w-full pl-7 pr-3 py-2.5 rounded-lg border text-base font-bold text-center bg-surface tnum ${
                        isCash ? 'border-success text-success'
                        : isCredito ? 'border-warn text-warn'
                        : 'border-primary text-primary'
                      }`} />
                  </div>
                  {!isCash && !isCredito && (
                    <input type="text" value={d.reference || ''}
                      onChange={e => updateDraft(i, { reference: e.target.value })}
                      placeholder="Ref. de transferencia (opcional)"
                      className="mt-1.5 w-full bg-surface border border-line rounded-lg px-3 py-2 text-ink-2 text-xs focus:border-primary outline-none" />
                  )}
                </div>
              );
            })}
          </div>

          {usingCredito && (
            <CreditoFields
              name={creditoName} setName={setCreditoName}
              phone={creditoPhone} setPhone={setCreditoPhone}
              dueDate={creditoDueDate} setDueDate={setCreditoDueDate}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CreditoFields({
  name, setName, phone, setPhone, dueDate, setDueDate,
}: {
  name: string; setName: (s: string) => void;
  phone: string; setPhone: (s: string) => void;
  dueDate: string; setDueDate: (s: string) => void;
}) {
  return (
    <div className="bg-warn-soft border border-warn/30 rounded-xl p-3 space-y-2">
      <p className="text-warn text-[11px] font-bold uppercase tracking-widest">Datos del cliente (crédito)</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <span className="block text-[10px] text-warn/80 font-bold uppercase tracking-wider mb-1">Nombre <span className="text-danger">*</span></span>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="Ej: Juan Pérez"
            autoFocus
            className="w-full bg-surface border border-warn/50 rounded-lg px-3 py-2 text-ink text-sm focus:border-warn outline-none" />
        </div>
        <div>
          <span className="block text-[10px] text-warn/80 font-bold uppercase tracking-wider mb-1">Teléfono</span>
          <input type="tel" inputMode="numeric" value={phone}
            onChange={e => setPhone(e.target.value.replace(/[^\d\s+()-]/g, ''))}
            placeholder="Ej: 300 123 4567"
            className="w-full bg-surface border border-warn/50 rounded-lg px-3 py-2 text-ink text-sm focus:border-warn outline-none" />
        </div>
      </div>
      <div>
        <span className="block text-[10px] text-warn/80 font-bold uppercase tracking-wider mb-1">¿Cuándo paga?</span>
        <DueDateCalendar value={dueDate} onChange={setDueDate} />
      </div>
      <p className="text-warn/90 text-[11px] leading-snug pt-0.5">
        Vence el <strong>{dueDateLabel(dueDate)}</strong>.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 2 — ¿Desea factura?
// ─────────────────────────────────────────────────────────────────────────────

function InvoiceAskStep({ total, usingCredito, onYes, onNo, loading }: { total: number; usingCredito: boolean; onYes: () => void; onNo: () => void; loading: boolean }) {
  const noBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { noBtnRef.current?.focus(); }, []);

  return (
    <div className="space-y-4 py-2">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary-soft mb-3">
          <span className="material-symbols-outlined text-primary text-3xl">receipt_long</span>
        </div>
        <h3 className="font-extrabold text-2xl">¿Desea factura?</h3>
        <p className="text-ink-3 text-sm mt-1">
          {usingCredito
            ? <>Venta registrada por <span className="text-warn font-bold">{COP(total)}</span> · incluye crédito</>
            : <>Cobro completado por <span className="text-success font-bold">{COP(total)}</span></>}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button ref={noBtnRef}
          onClick={onNo} disabled={loading}
          onKeyDown={e => { if (e.key === 'Enter') onNo(); }}
          className="h-24 bg-surface-2 hover:bg-surface-3 border-2 border-line hover:border-line-strong disabled:opacity-40 font-extrabold text-xl rounded-xl transition-all active:scale-[0.98] flex flex-col items-center justify-center gap-1">
          <span className="material-symbols-outlined text-[28px]">close</span>
          NO
          <span className="text-[10px] font-medium text-ink-3 tracking-wider uppercase">Consumidor final</span>
        </button>
        <button onClick={onYes} disabled={loading}
          className="h-24 bg-primary-soft hover:bg-primary/20 border-2 border-primary disabled:opacity-40 font-extrabold text-xl rounded-xl transition-all active:scale-[0.98] flex flex-col items-center justify-center gap-1">
          <span className="material-symbols-outlined text-[28px] text-primary">receipt_long</span>
          SÍ
          <span className="text-[10px] font-medium text-primary tracking-wider uppercase">Pedir datos</span>
        </button>
      </div>

      <p className="text-ink-4 text-[11px] text-center">
        Pulsa <kbd className="px-1.5 py-0.5 bg-surface-3 rounded text-ink-2 font-mono">Enter</kbd> para registrar como consumidor final y seguir vendiendo.
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
        <button onClick={onBack} className="text-ink-3 hover:text-ink p-1 rounded-lg hover:bg-surface-2">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h3 className="font-bold text-lg">Datos para la factura</h3>
          <p className="text-ink-3 text-xs">Se enviará al WhatsApp del cliente.</p>
        </div>
      </div>

      <Field label="WhatsApp" required hint="Para enviar la factura electrónica">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-success text-[20px]">chat</span>
          <input ref={waRef} type="tel" inputMode="numeric" value={wa}
            onChange={e => setWa(e.target.value.replace(/[^\d\s+()-]/g, ''))}
            placeholder="Ej: 300 123 4567"
            className="w-full pl-11 pr-3 py-3 bg-surface-2 border border-success/60 rounded-xl text-ink text-base font-semibold focus:border-success outline-none" />
        </div>
      </Field>

      <Field label="Nombre del cliente" required>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="Ej: Juan Pérez"
          className="w-full px-3 py-2.5 bg-surface-2 border border-line rounded-xl text-ink text-sm focus:border-primary outline-none" />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="NIT / Cédula" hint="Opcional">
          <input type="text" value={doc} onChange={e => setDoc(e.target.value)}
            placeholder="123.456.789"
            className="w-full px-3 py-2.5 bg-surface-2 border border-line rounded-xl text-ink text-sm focus:border-primary outline-none" />
        </Field>
        <Field label="Correo" hint="Opcional">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="cliente@correo.com"
            className="w-full px-3 py-2.5 bg-surface-2 border border-line rounded-xl text-ink text-sm focus:border-primary outline-none" />
        </Field>
      </div>

      <Field label="Dirección" hint="Opcional — útil para domicilios y facturación física">
        <input type="text" value={address} onChange={e => setAddress(e.target.value)}
          placeholder="Ej: Cra 123 #45-67, Bogotá"
          className="w-full px-3 py-2.5 bg-surface-2 border border-line rounded-xl text-ink text-sm focus:border-primary outline-none" />
      </Field>

      {err && <div className="text-danger text-xs bg-danger-soft border border-danger/50 px-3 py-2 rounded-lg">{err}</div>}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <button onClick={onConfirm} disabled={loading}
          className="h-12 bg-primary hover:bg-primary-ink disabled:opacity-45 text-white font-bold rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
          <span className="material-symbols-outlined">check_circle</span>
          {loading ? 'Procesando…' : 'Emitir factura'}
        </button>
        <button onClick={onBack}
          className="h-12 bg-surface-2 hover:bg-surface-3 border border-line text-ink-2 font-semibold rounded-xl transition-colors">
          Atrás
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ─────────────────────────────────────────────────────────────────────────────

function Stat({ label, value, color = 'text-ink' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface-2 border border-line rounded-xl p-2.5">
      <p className="text-ink-3 text-[10px] font-bold uppercase tracking-wider">{label}</p>
      <p className={`font-extrabold text-base tnum ${color}`}>{value}</p>
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-ink-3 font-bold uppercase tracking-widest mb-1">
        {label} {required && <span className="text-danger">*</span>}
        {hint && <span className="text-ink-4 normal-case font-medium tracking-normal ml-1.5">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}
