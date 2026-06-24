import { useState, useEffect } from 'react';
import Login from './pages/Login';
import SelectCashier from './pages/SelectCashier';
import Pos from './pages/Pos';
import CajaCajero from './pages/CajaCajero';
import CreditosCajero from './pages/CreditosCajero';
import VentasCajero from './pages/VentasCajero';
import ClientesCajero from './pages/ClientesCajero';
import { loadSession, saveSession, clearSession, type PosSession } from './lib/storage';
import { getActiveCashier, setActiveCashier, setSessionEpoch } from './services/api';

type Tab = 'pos' | 'caja' | 'creditos' | 'ventas' | 'clientes';
type Theme = 'dark' | 'light';

type Screen =
  | { kind: 'login' }
  | { kind: 'selectCashier'; session: PosSession }
  | { kind: 'app'; session: PosSession };

function initialScreen(): Screen {
  const s = loadSession();
  if (!s) return { kind: 'login' };
  // Token (caja) persiste; el empleado activo vive en sessionStorage → si la
  // pestaña se cerró, se vuelve a pedir el empleado/PIN.
  return getActiveCashier()
    ? { kind: 'app', session: s }
    : { kind: 'selectCashier', session: s };
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('mc-theme');
  return saved === 'light' ? 'light' : 'dark';
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'pos',      icon: 'point_of_sale',          label: 'POS'      },
  { id: 'caja',     icon: 'account_balance_wallet',  label: 'Caja'     },
  { id: 'creditos',   icon: 'handshake',               label: 'Créditos'   },
  { id: 'ventas',   icon: 'receipt_long',             label: 'Ventas'   },
  { id: 'clientes', icon: 'groups',                  label: 'Clientes' },
];

// Iniciales para el avatar del empleado (máx. 2).
function initialsOf(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [tab, setTab] = useState<Tab>('pos');
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Aplica el tema al <html> y lo persiste. El index.html arranca en dark para
  // evitar flash; aquí sincronizamos con la preferencia guardada.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mc-theme', theme);
  }, [theme]);

  useEffect(() => {
    const handleExpired = () => {
      clearSession();
      setActiveCashier(null);
      // Drop the in-memory epoch so the next login starts clean — otherwise the
      // stale value would 401 the first call after re-login (session_revoked).
      setSessionEpoch(null);
      setScreen({ kind: 'login' });
      setTab('pos');
    };
    const handleLocked = () => {
      // El admin cerró la sesión de la caja: volvemos al selector de empleado
      // conservando el token (la sesión de dispositivo sigue viva).
      setActiveCashier(null);
      setScreen(prev =>
        prev.kind === 'app'
          ? { kind: 'selectCashier', session: prev.session }
          : prev,
      );
      setTab('pos');
    };
    window.addEventListener('pos:session-expired', handleExpired);
    window.addEventListener('pos:cashier-locked', handleLocked);
    return () => {
      window.removeEventListener('pos:session-expired', handleExpired);
      window.removeEventListener('pos:cashier-locked', handleLocked);
    };
  }, []);

  function onLoggedIn(data: { jwt: string; expiresAt: number; cash: PosSession['cash']; sessionEpoch?: number }) {
    const s: PosSession = { jwt: data.jwt, expiresAt: data.expiresAt, cash: data.cash };
    saveSession(s);
    setActiveCashier(null);
    // Seed the epoch the server just bumped at login, so every subsequent
    // request carries the current value (not a stale one left in module memory
    // from a previous session) and passes the single-active-device check.
    setSessionEpoch(data.sessionEpoch ?? null);
    // Tras pegar el token (caja) → elegir empleado antes de entrar.
    setScreen({ kind: 'selectCashier', session: s });
    setTab('pos');
  }

  function onCashierSelected(session: PosSession) {
    setScreen({ kind: 'app', session });
    setTab('pos');
  }

  function onSwitchCashier(session: PosSession) {
    // "Cambiar empleado": vuelve al selector SIN perder el token de la caja.
    setActiveCashier(null);
    setScreen({ kind: 'selectCashier', session });
  }

  function onLogout() {
    clearSession();
    setActiveCashier(null);
    setSessionEpoch(null);
    setScreen({ kind: 'login' });
  }

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  if (screen.kind === 'login') {
    return <Login onLoggedIn={onLoggedIn} />;
  }

  if (screen.kind === 'selectCashier') {
    return (
      <SelectCashier
        cashLabel={screen.session.cash.label || screen.session.cash.deviceName}
        onSelected={() => onCashierSelected(screen.session)}
        onLogout={onLogout}
      />
    );
  }

  const { session } = screen;
  const activeCashier = getActiveCashier();

  return (
    <div className="flex flex-col h-screen bg-bg text-ink overflow-hidden">
      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <header className="shrink-0 bg-surface border-b border-line flex items-center justify-between gap-2 px-3 sm:px-4 h-14">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl grid place-items-center shrink-0 text-white font-extrabold text-sm shadow-token2"
               style={{ background: 'linear-gradient(140deg, rgb(var(--tc-primary)), rgb(var(--tc-primary-ink)))' }}>
            M
          </div>
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-bold tracking-tight text-[15px] truncate">
              Merchant <span className="text-primary font-extrabold">AI</span>
            </span>
            <span className="hidden sm:inline text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3 border border-line rounded-full px-2 py-0.5">
              Cajero
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {activeCashier && (
            <button onClick={() => onSwitchCashier(session)}
              className="flex items-center gap-2 h-9 pl-1 pr-2.5 rounded-full bg-surface-2 border border-line hover:border-line-strong transition-colors"
              title="Cambiar de empleado">
              <span className="w-6 h-6 rounded-lg grid place-items-center text-white text-[10px] font-bold"
                    style={{ background: session.cash.color || 'rgb(var(--tc-primary))' }}>
                {initialsOf(activeCashier.name)}
              </span>
              <span className="text-[13px] font-semibold truncate max-w-[88px]">{activeCashier.name.split(' ')[0]}</span>
              <span className="material-symbols-outlined text-[16px] text-ink-3">unfold_more</span>
            </button>
          )}
          <button onClick={toggleTheme}
            className="flex items-center gap-1.5 h-9 px-3 rounded-full bg-surface-2 border border-line hover:border-line-strong text-ink-2 text-[13px] font-semibold transition-colors"
            title="Cambiar tema">
            <span className="material-symbols-outlined text-[18px]">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
            <span className="hidden sm:inline">{theme === 'dark' ? 'Claro' : 'Oscuro'}</span>
          </button>
          <button onClick={onLogout}
            className="w-9 h-9 grid place-items-center rounded-full text-ink-3 hover:text-danger hover:bg-surface-2 transition-colors"
            title="Salir">
            <span className="material-symbols-outlined text-[20px]">logout</span>
          </button>
        </div>
      </header>

      {/* Content — Pos siempre está montado para preservar el carrito al cambiar
          de tab; las demás se montan solo cuando están activas para evitar que
          todas disparen su fetch inicial en paralelo (con sesión stale eso
          causaba un cascade de 401 en consola). */}
      <main className="flex-1 overflow-hidden">
        <div className={tab === 'pos' ? 'h-full' : 'hidden'}>
          <Pos session={session} onLogout={onLogout} />
        </div>
        {tab === 'caja'     && <CajaCajero />}
        {tab === 'creditos'   && <CreditosCajero />}
        {tab === 'ventas'   && <VentasCajero session={session} />}
        {tab === 'clientes' && <ClientesCajero />}
      </main>

      {/* ── Bottom nav ────────────────────────────────────────────────────── */}
      <nav className="shrink-0 bg-surface border-t border-line flex">
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
                active ? 'text-primary' : 'text-ink-4 hover:text-ink-2'
              }`}>
              {active && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />}
              <span className="material-symbols-outlined text-[22px]">{t.icon}</span>
              <span className="text-[10px] font-semibold">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
