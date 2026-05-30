import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface Props {
  onLoggedIn: (data: { jwt: string; expiresAt: number; cash: any }) => void;
}

export default function Login({ onLoggedIn }: Props) {
  const [code, setCode] = useState('');
  const [pin,  setPin]  = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const pinRef  = useRef<HTMLInputElement>(null);

  useEffect(() => { codeRef.current?.focus(); }, []);

  async function submit() {
    setError(null);
    if (!code.trim()) { setError('Ingresa el código de acceso'); codeRef.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await api.login(code.trim(), pin.trim(), navigator.userAgent.slice(0, 80));
      const expiresAt = Math.floor(Date.now() / 1000) + r.expiresInS;
      onLoggedIn({ jwt: r.jwt, expiresAt, cash: r.cash });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'No se pudo conectar';
      const isPinRequired =
        e instanceof ApiError &&
        (e.code === 'pin-required' || (e.status === 400 && msg.toLowerCase().includes('pin')));
      if (isPinRequired) {
        setError('Esta caja requiere PIN. Ingrésalo para continuar.');
        setPin('');
        setTimeout(() => pinRef.current?.focus(), 50);
      } else {
        setError(msg);
        setPin('');
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-[#121212] border border-[#222] rounded-3xl p-8 shadow-2xl">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
               style={{ background: 'linear-gradient(135deg, #9acee1, #95d4b3)' }}>
            <span className="text-[#0a0c0d] font-black text-base">A</span>
          </div>
          <div>
            <div className="text-white font-bold text-lg leading-tight">Acceso POS</div>
            <div className="text-[#8a9295] text-xs">Ingresa el código que te dio el administrador</div>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <div>
            <label className="block text-[#8a9295] text-[11px] uppercase tracking-wider font-bold mb-1.5">
              Código de acceso
            </label>
            <input
              ref={codeRef}
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="off"
              spellCheck={false}
              placeholder="Pega aquí el código del administrador"
              className="w-full bg-[#1a1a1a] border border-[#333] rounded-xl px-4 py-3.5 text-sm text-white font-mono placeholder:text-[#40484b] placeholder:font-sans focus:border-[#9acee1] transition-colors outline-none"
            />
            <div className="text-[#40484b] text-[10px] mt-1.5">El administrador genera este código en la vista Cajeros → Generar token</div>
          </div>

          <div>
            <label className="block text-[#8a9295] text-[11px] uppercase tracking-wider font-bold mb-1.5">
              PIN <span className="text-[#40484b] normal-case tracking-normal font-normal">(si tu caja tiene)</span>
            </label>
            <input
              ref={pinRef}
              value={pin}
              onChange={e => setPin(e.target.value)}
              onKeyDown={onKeyDown}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="••••"
              className="w-full bg-[#1a1a1a] border border-[#333] rounded-xl px-4 py-3.5 text-2xl text-white tracking-[0.5em] placeholder:text-[#40484b] focus:border-[#9acee1] transition-colors outline-none"
            />
            <div className="text-[#40484b] text-[10px] mt-1.5">Déjalo vacío si tu caja no tiene PIN configurado</div>
          </div>

          {error && (
            <div className="bg-[#3a1010] border border-[#5a1818] text-[#ffb4ab] px-3 py-2 rounded-lg text-sm flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy || !code.trim()}
            className="w-full bg-gradient-to-r from-[#9acee1] to-[#95d4b3] text-[#0a0c0d] font-bold py-3.5 rounded-xl text-base disabled:opacity-50 transition-opacity active:scale-[0.98]">
            {busy ? 'Conectando…' : 'Ingresar'}
          </button>
        </div>

        <div className="mt-6 text-center text-[#40484b] text-[11px]">
          Si no tienes un código, pídele al administrador que cree uno en la sección Cajeros.
        </div>
      </div>
    </div>
  );
}
