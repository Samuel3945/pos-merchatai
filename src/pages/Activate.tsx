import { useMemo, useState } from 'react';
import { api } from '../services/api';

// Standalone PIN-activation screen (Option B). Reached via the WhatsApp link the
// admin sends: `${POS_WEB_URL}/activar?token=<rawToken>`. No POS login/session is
// needed — the one-time token IS the auth. The employee sets their OWN PIN twice;
// on success the PIN is stored (bcrypt) server-side and the token is burned.

type Step =
  | { kind: 'new' }
  | { kind: 'confirm'; first: string }
  | { kind: 'done'; name: string };

function readToken(): string {
  try {
    return new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

export default function Activate() {
  const token = useMemo(readToken, []);
  const [step, setStep] = useState<Step>({ kind: 'new' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function goToPos() {
    // Drop the token from the URL and land on the normal POS entry (login/select).
    window.location.replace('/');
  }

  async function submit(second: string, first: string) {
    if (second !== first) {
      setError('Los PIN no coinciden. Inténtalo de nuevo.');
      setStep({ kind: 'new' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.cashiers.activate(token, first);
      setStep({ kind: 'done', name: r.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo activar el PIN');
      setStep({ kind: 'new' });
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <Shell>
        <div className="text-center">
          <span className="material-symbols-outlined text-danger text-[40px]">link_off</span>
          <div className="text-ink font-bold text-lg mt-2">Enlace inválido</div>
          <div className="text-ink-3 text-sm mt-1">
            Este enlace de activación no es válido. Pídele al administrador que te
            reenvíe uno por WhatsApp.
          </div>
        </div>
      </Shell>
    );
  }

  if (step.kind === 'done') {
    return (
      <Shell>
        <div className="text-center">
          <span className="material-symbols-outlined text-success text-[44px]">check_circle</span>
          <div className="text-ink font-bold text-lg mt-2">¡PIN activado!</div>
          <div className="text-ink-3 text-sm mt-1">
            Listo{step.name ? `, ${step.name}` : ''}. Ya puedes entrar a la caja con
            tu PIN personal.
          </div>
          <button
            onClick={goToPos}
            className="mt-5 w-full bg-gradient-to-r from-primary to-success text-white font-bold py-3.5 rounded-xl text-base active:scale-[0.98] transition-transform">
            Ir a la caja
          </button>
        </div>
      </Shell>
    );
  }

  const title
    = step.kind === 'confirm' ? 'Confirma tu PIN' : 'Crea tu PIN';
  const subtitle
    = step.kind === 'confirm'
      ? 'Vuelve a ingresarlo para confirmar'
      : 'Elige un PIN de 4 a 8 dígitos. No lo compartas con nadie.';

  return (
    <Shell>
      <div className="text-center mb-4">
        <div className="w-12 h-12 mx-auto rounded-2xl flex items-center justify-center"
             style={{ background: 'linear-gradient(135deg, rgb(var(--tc-primary)), rgb(var(--tc-primary-ink)))' }}>
          <span className="material-symbols-outlined text-white text-[26px]">password</span>
        </div>
        <div className="text-ink font-bold text-lg mt-3">{title}</div>
        <div className="text-ink-3 text-xs mt-1">{subtitle}</div>
      </div>
      <Keypad
        key={step.kind}
        busy={busy}
        error={error}
        submitLabel={step.kind === 'confirm' ? 'Activar' : 'Siguiente'}
        onSubmit={(pin) => {
          if (step.kind === 'new') {
            setError(null);
            setStep({ kind: 'confirm', first: pin });
          } else {
            submit(pin, step.first);
          }
        }}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-bg">
      <div className="w-full max-w-xs bg-surface border border-line rounded-3xl p-6 shadow-token3">
        {children}
      </div>
    </div>
  );
}

// Numeric keypad matching SelectCashier's PinPad look. Kept local so /activar has
// zero dependency on the logged-in POS shell.
function Keypad({
  busy, error, onSubmit, submitLabel,
}: {
  busy?: boolean;
  error?: string | null;
  onSubmit: (pin: string) => void;
  submitLabel: string;
}) {
  const [pin, setPin] = useState('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <div>
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
      <button onClick={() => onSubmit(pin)} disabled={busy || pin.length < 4}
        className="mt-4 w-full py-3 rounded-xl bg-gradient-to-r from-primary to-success text-white text-sm font-bold disabled:opacity-50">
        {busy ? '…' : submitLabel}
      </button>
    </div>
  );
}
