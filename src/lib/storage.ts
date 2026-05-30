// Persisted POS device session. We store enough to restore the UI on reload
// without forcing re-login until the JWT actually expires.

const KEY = 'pos_web_session_v1';

export interface PosSession {
  jwt:        string;
  expiresAt:  number;          // unix seconds
  cash: {
    id:           string;
    displayCode:  string;
    deviceName:   string;
    cashierId:    string | null;
    locationId:   string | null;
    label:        string | null;
    color:        string | null;
  };
}

export function loadSession(): PosSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PosSession;
    if (!s.jwt || !s.expiresAt) return null;
    if (s.expiresAt * 1000 < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: PosSession): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch {}
}
