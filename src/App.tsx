import { useState, useEffect } from 'react';
import Login from './pages/Login';
import SelectCashier from './pages/SelectCashier';
import Pos from './pages/Pos';
import CajaCajero from './pages/CajaCajero';
import FiadosCajero from './pages/FiadosCajero';
import VentasCajero from './pages/VentasCajero';
import ClientesCajero from './pages/ClientesCajero';
import { loadSession, saveSession, clearSession, type PosSession } from './lib/storage';
import { getActiveCashier, setActiveCashier } from './services/api';

type Tab = 'pos' | 'caja' | 'fiados' | 'ventas' | 'clientes';

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

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'pos',      icon: 'point_of_sale',          label: 'POS'      },
  { id: 'caja',     icon: 'account_balance_wallet',  label: 'Caja'     },
  { id: 'fiados',   icon: 'handshake',               label: 'Fiados'   },
  { id: 'ventas',   icon: 'receipt_long',             label: 'Ventas'   },
  { id: 'clientes', icon: 'groups',                  label: 'Clientes' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [tab, setTab] = useState<Tab>('pos');

  useEffect(() => {
    const handleExpired = () => {
      clearSession();
      setActiveCashier(null);
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

  function onLoggedIn(data: { jwt: string; expiresAt: number; cash: PosSession['cash'] }) {
    const s: PosSession = { jwt: data.jwt, expiresAt: data.expiresAt, cash: data.cash };
    saveSession(s);
    setActiveCashier(null);
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
    setScreen({ kind: 'login' });
  }

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
    <div className="flex flex-col h-screen bg-[#111415] overflow-hidden">
      {/* Header */}
      <header className="shrink-0 bg-[#121212] border-b border-[#222] flex items-center justify-between px-4 h-12">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
               style={{ background: 'linear-gradient(135deg,#9acee1,#95d4b3)' }}>
            <span className="text-[#0a0c0d] font-black text-xs">A</span>
          </div>
          <span className="text-white font-bold text-sm tracking-tight">Merchant AI Cajero</span>
        </div>
        <div className="flex items-center gap-3">
          {activeCashier && (
            <button onClick={() => onSwitchCashier(session)}
              className="flex items-center gap-1.5 text-[#9acee1] hover:text-white text-xs font-medium transition-colors"
              title="Cambiar de empleado">
              <span className="material-symbols-outlined text-[16px]">switch_account</span>
              <span className="truncate max-w-[120px]">{activeCashier.name}</span>
            </button>
          )}
          <span className="text-[#8a9295] text-xs hidden sm:block truncate max-w-[120px]">
            {session.cash.label || session.cash.deviceName}
          </span>
          <button onClick={onLogout}
            className="flex items-center gap-1 text-[#8a9295] hover:text-[#ffb4ab] text-xs font-medium transition-colors">
            <span className="material-symbols-outlined text-[16px]">logout</span>
            <span className="hidden sm:inline">Salir</span>
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
        {tab === 'fiados'   && <FiadosCajero />}
        {tab === 'ventas'   && <VentasCajero session={session} />}
        {tab === 'clientes' && <ClientesCajero />}
      </main>

      {/* Bottom nav */}
      <nav className="shrink-0 bg-[#121212] border-t border-[#222] flex">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
              tab === t.id
                ? 'text-[#9acee1]'
                : 'text-[#40484b] hover:text-[#8a9295]'
            }`}>
            <span className={`material-symbols-outlined text-[22px] ${tab === t.id ? 'text-[#9acee1]' : ''}`}>
              {t.icon}
            </span>
            <span className="text-[10px] font-semibold">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
