import { useState, useEffect } from 'react';
import Login from './pages/Login';
import Pos from './pages/Pos';
import CajaCajero from './pages/CajaCajero';
import FiadosCajero from './pages/FiadosCajero';
import VentasCajero from './pages/VentasCajero';
import ClientesCajero from './pages/ClientesCajero';
import { loadSession, saveSession, clearSession, type PosSession } from './lib/storage';

type Tab = 'pos' | 'caja' | 'fiados' | 'ventas' | 'clientes';

type Screen =
  | { kind: 'login' }
  | { kind: 'app'; session: PosSession };

function initialScreen(): Screen {
  const s = loadSession();
  return s ? { kind: 'app', session: s } : { kind: 'login' };
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
      setScreen({ kind: 'login' });
      setTab('pos');
    };
    window.addEventListener('pos:session-expired', handleExpired);
    return () => window.removeEventListener('pos:session-expired', handleExpired);
  }, []);

  function onLoggedIn(data: { jwt: string; expiresAt: number; cash: PosSession['cash'] }) {
    const s: PosSession = { jwt: data.jwt, expiresAt: data.expiresAt, cash: data.cash };
    saveSession(s);
    setScreen({ kind: 'app', session: s });
    setTab('pos');
  }

  function onLogout() {
    clearSession();
    setScreen({ kind: 'login' });
  }

  if (screen.kind === 'login') {
    return <Login onLoggedIn={onLoggedIn} />;
  }

  const { session } = screen;

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
          <span className="text-[#8a9295] text-xs hidden sm:block truncate max-w-[160px]">
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
