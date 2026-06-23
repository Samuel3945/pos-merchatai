import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import QrScanner from '../components/QrScanner';

interface Props {
  onLoggedIn: (data: { jwt: string; expiresAt: number; cash: any; sessionEpoch?: number }) => void;
}

// The access QR encodes a deep link like https://pos.../?code=TOKEN. Accept
// both that URL (scanned in-app or via the phone camera) and a raw token.
function extractAccessCode(text: string): string {
  const raw = text.trim();
  try {
    const url = new URL(raw);
    const fromParam = url.searchParams.get('code');
    if (fromParam) return fromParam.trim();
  } catch {
    // not a URL — treat as a raw token
  }
  return raw;
}

export default function Login({ onLoggedIn }: Props) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Deep link from the access QR scanned with a regular camera: the URL
    // carries ?code=, so we log in straight away — the token is all we need.
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('code');
    if (fromUrl && fromUrl.trim()) {
      const token = fromUrl.trim();
      setCode(token);
      // Drop the token from the address bar / browser history.
      window.history.replaceState(null, '', window.location.pathname);
      submit(token);
      return;
    }
    codeRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleScan(text: string) {
    const scanned = extractAccessCode(text);
    setScanning(false);
    if (scanned) {
      setCode(scanned);
      setError(null);
      // Token scanned — go in directly, no extra step.
      submit(scanned);
    }
  }

  async function submit(explicitCode?: string) {
    setError(null);
    const accessCode = extractAccessCode(explicitCode ?? code);
    if (!accessCode) { setError('Ingresa el código de acceso'); codeRef.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await api.login(accessCode, navigator.userAgent.slice(0, 80));
      const expiresAt = Math.floor(Date.now() / 1000) + r.expiresInS;
      onLoggedIn({ jwt: r.jwt, expiresAt, cash: r.cash, sessionEpoch: r.sessionEpoch });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo conectar');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-surface border border-line rounded-3xl p-8 shadow-token3">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
               style={{ background: 'linear-gradient(135deg, rgb(var(--tc-primary)), rgb(var(--tc-primary-ink)))' }}>
            <span className="text-white font-black text-base">A</span>
          </div>
          <div>
            <div className="text-ink font-bold text-lg leading-tight">Acceso POS</div>
            <div className="text-ink-3 text-xs">Ingresa el código que te dio el administrador</div>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <div>
            <label className="block text-ink-3 text-[11px] uppercase tracking-wider font-bold mb-1.5">
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
              className="w-full bg-surface-2 border border-line rounded-xl px-4 py-3.5 text-sm text-ink font-mono placeholder:text-ink-4 placeholder:font-sans focus:border-primary transition-colors outline-none"
            />
            <div className="text-ink-4 text-[10px] mt-1.5">El administrador genera este código en la vista Cajeros → Generar token</div>
            <button
              type="button"
              onClick={() => setScanning(true)}
              className="mt-2 w-full flex items-center justify-center gap-2 bg-surface-2 border border-line hover:border-primary text-primary font-semibold py-2.5 rounded-xl text-sm transition-colors active:scale-[0.98]">
              <span className="material-symbols-outlined text-[18px]">qr_code_scanner</span>
              Escanear QR de acceso
            </button>
          </div>

          {error && (
            <div className="bg-danger-soft border border-danger text-danger px-3 py-2 rounded-lg text-sm flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={() => submit()}
            disabled={busy || !code.trim()}
            className="w-full bg-gradient-to-r from-primary to-success text-white font-bold py-3.5 rounded-xl text-base disabled:opacity-50 transition-opacity active:scale-[0.98]">
            {busy ? 'Conectando…' : 'Ingresar'}
          </button>
        </div>

        <div className="mt-6 text-center text-ink-4 text-[11px]">
          Si no tienes un código, pídele al administrador que cree uno en la sección Cajeros.
        </div>
      </div>
      {scanning && <QrScanner onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}
