import { useEffect, useRef, useState } from 'react';
import { api, setActiveCashier, type CashierLite } from '../services/api';

interface Props {
  cashLabel: string;
  onSelected: () => void;   // empleado activo ya seteado (o entrada sin empleado)
  onLogout: () => void;     // cerrar la caja (vuelve al token)
}

type Mode =
  | { kind: 'list' }
  | { kind: 'pin'; cashier: CashierLite }
  | { kind: 'setpin'; cashier: CashierLite };

const roleLabel: Record<string, string> = {
  admin: 'Administrador',
  cashier: 'Cajero',
  employee: 'Empleado',
};

export default function SelectCashier({ cashLabel, onSelected, onLogout }: Props) {
  const [cashiers, setCashiers] = useState<CashierLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await api.cashiers.list();
      setCashiers(r.cashiers);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar empleados');
      setCashiers([]);
    }
  }

  useEffect(() => { load(); }, []);

  async function enterAs(c: CashierLite, pin: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.cashiers.verifyPin(c.id, pin);
      if (r.ok) {
        setActiveCashier({ id: r.cashier.id, name: r.cashier.name, role: r.cashier.role });
        onSelected();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PIN incorrecto');
    } finally {
      setBusy(false);
    }
  }

  function pick(c: CashierLite) {
    // Entrar SIEMPRE exige el PIN propio del empleado. Sin PIN activado no se
    // puede entrar (evita suplantación): el empleado debe activarlo con el enlace
    // que el admin le envió por WhatsApp.
    if (c.hasPin) {
      setError(null);
      setMode({ kind: 'pin', cashier: c });
    } else {
      setError(
        `${c.name}: aún no activas tu PIN. Revisa tu WhatsApp o pídele al admin que reenvíe el enlace.`,
      );
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (mode.kind === 'pin') {
    return (
      <PinPad
        title={`PIN de ${mode.cashier.name}`}
        busy={busy}
        error={error}
        onCancel={() => { setError(null); setMode({ kind: 'list' }); }}
        onSubmit={pin => enterAs(mode.cashier, pin)}
      />
    );
  }

  if (mode.kind === 'setpin') {
    return (
      <SetPin
        cashier={mode.cashier}
        onDone={() => { setMode({ kind: 'list' }); load(); }}
        onCancel={() => setMode({ kind: 'list' })}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg">
      <header className="shrink-0 bg-surface border-b border-line flex items-center justify-between px-4 h-12">
        <span className="text-ink font-bold text-sm tracking-tight truncate">{cashLabel || 'Caja'}</span>
        <button onClick={onLogout}
          className="flex items-center gap-1 text-ink-3 hover:text-danger text-xs font-medium transition-colors">
          <span className="material-symbols-outlined text-[16px]">logout</span>
          <span>Cerrar caja</span>
        </button>
      </header>

      <div className="flex-1 overflow-auto p-5">
        <div className="max-w-2xl mx-auto">
          <div className="text-ink font-bold text-lg mb-1">¿Quién está en la caja?</div>
          <div className="text-ink-3 text-xs mb-5">Selecciona tu perfil para empezar a vender</div>

          {error && (
            <div className="bg-danger-soft border border-danger text-danger px-3 py-2 rounded-lg text-sm mb-4">{error}</div>
          )}

          {cashiers === null && <div className="text-ink-3 text-sm">Cargando…</div>}

          {cashiers !== null && cashiers.length === 0 && (
            <div className="bg-surface border border-line rounded-2xl p-6 text-center">
              <div className="text-ink-3 text-sm mb-4">
                No hay empleados configurados. Pídele al administrador que cree cajeros
                en MerchantAI (Empleados), o entra directo a la caja.
              </div>
              <button onClick={onSelected}
                className="bg-gradient-to-r from-primary to-success text-white font-bold py-2.5 px-5 rounded-xl text-sm">
                Entrar a la caja
              </button>
            </div>
          )}

          {cashiers !== null && cashiers.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {cashiers.map(c => (
                <div key={c.id}
                  className="relative bg-surface border border-line rounded-2xl p-4 hover:border-primary transition-colors">
                  <button onClick={() => pick(c)} className="w-full flex flex-col items-center gap-2 text-center">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center text-white font-black text-xl"
                         style={{ background: 'linear-gradient(135deg, rgb(var(--tc-primary)), rgb(var(--tc-primary-ink)))' }}>
                      {c.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="text-ink font-semibold text-sm truncate max-w-full">{c.name}</div>
                    <div className="text-ink-4 text-[10px] uppercase tracking-wide">{roleLabel[c.role] || c.role}</div>
                    {c.hasPin && (
                      <span className="material-symbols-outlined text-primary text-[16px] absolute top-2 right-2">lock</span>
                    )}
                  </button>
                  {c.hasPin
                    ? (
                        <button onClick={() => setMode({ kind: 'setpin', cashier: c })}
                          className="mt-2 w-full text-ink-3 hover:text-primary text-[11px] flex items-center justify-center gap-1 transition-colors">
                          <span className="material-symbols-outlined text-[14px]">key</span>
                          Cambiar PIN
                        </button>
                      )
                    : (
                        <div className="mt-2 w-full text-amber-500 text-[11px] flex items-center justify-center gap-1">
                          <span className="material-symbols-outlined text-[14px]">schedule</span>
                          Pendiente de activar
                        </div>
                      )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Teclado PIN reutilizable ───────────────────────────────────────────────────
function PinPad({
  title, busy, error, onSubmit, onCancel, submitLabel = 'Entrar',
}: {
  title: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const [pin, setPin] = useState('');
  const keys = ['1','2','3','4','5','6','7','8','9','','0','del'];

  // Teclado físico (PC): dígitos escriben, Backspace borra, Enter confirma.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setPin(p => (p.length < 8 ? p + e.key : p));
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setPin(p => p.slice(0, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pinRef.current.length >= 4) onSubmit(pinRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onSubmit]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-bg">
      <div className="w-full max-w-xs bg-surface border border-line rounded-3xl p-6">
        <div className="text-ink font-bold text-center mb-4">{title}</div>
        <div className="flex justify-center gap-2 mb-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={`w-3 h-3 rounded-full ${i < pin.length ? 'bg-primary' : 'bg-surface-2'}`} />
          ))}
        </div>
        {error && <div className="text-danger text-sm text-center mb-3">{error}</div>}
        <div className="grid grid-cols-3 gap-2">
          {keys.map((k, i) => k === '' ? <div key={i} /> : (
            <button key={i}
              onClick={() => {
                if (k === 'del') setPin(p => p.slice(0, -1));
                else if (pin.length < 8) setPin(p => p + k);
              }}
              className="h-14 rounded-xl bg-surface-2 border border-line text-ink text-xl font-semibold active:scale-95 transition-transform flex items-center justify-center">
              {k === 'del' ? <span className="material-symbols-outlined">backspace</span> : k}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onCancel} disabled={busy}
            className="flex-1 py-3 rounded-xl bg-surface-2 border border-line text-ink-3 text-sm font-semibold">
            Cancelar
          </button>
          <button onClick={() => onSubmit(pin)} disabled={busy || pin.length < 4}
            className="flex-1 py-3 rounded-xl bg-gradient-to-r from-primary to-success text-white text-sm font-bold disabled:opacity-50">
            {busy ? '…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Configurar / cambiar PIN propio ────────────────────────────────────────────
function SetPin({ cashier, onDone, onCancel }: {
  cashier: CashierLite;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  // 'current' (PIN viejo) → 'new' (PIN nuevo) → 'verify' (confirmar el nuevo).
  const [step, setStep] = useState<'current' | 'new' | 'verify'>(
    cashier.hasPin ? 'current' : 'new',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(np: string, cp: string) {
    setBusy(true);
    setError(null);
    try {
      await api.cashiers.setPin(cashier.id, cp, np);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el PIN');
      setStep(cashier.hasPin ? 'current' : 'new');
      setCurrentPin('');
      setNewPin('');
    } finally {
      setBusy(false);
    }
  }

  // key={step}: cada paso monta un PinPad NUEVO → empieza vacío (no arrastra el
  // PIN del paso anterior).
  if (step === 'current') {
    return (
      <PinPad key="current" title={`PIN actual de ${cashier.name}`} busy={busy} error={error}
        submitLabel="Siguiente"
        onCancel={onCancel}
        onSubmit={cp => { setCurrentPin(cp); setError(null); setStep('new'); }} />
    );
  }
  if (step === 'new') {
    return (
      <PinPad key="new" title={`Nuevo PIN de ${cashier.name}`} busy={busy} error={error}
        submitLabel="Siguiente"
        onCancel={onCancel}
        onSubmit={np => { setNewPin(np); setError(null); setStep('verify'); }} />
    );
  }
  return (
    <PinPad key="verify" title="Confirma el nuevo PIN" busy={busy} error={error}
      submitLabel="Guardar"
      onCancel={onCancel}
      onSubmit={(vp) => {
        if (vp !== newPin) {
          setError('Los PIN no coinciden, intenta de nuevo');
          setNewPin('');
          setStep('new');
          return;
        }
        save(newPin, currentPin);
      }} />
  );
}
