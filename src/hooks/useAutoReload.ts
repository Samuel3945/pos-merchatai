import { useEffect, useRef } from 'react';

const POLL_INTERVAL = 60_000; // cada 60 segundos

export function useAutoReload() {
  const buildTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) return;

    async function checkVersion() {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const { buildTime } = await res.json();

        if (buildTimeRef.current === null) {
          buildTimeRef.current = buildTime;
        } else if (buildTimeRef.current !== buildTime) {
          window.location.reload();
        }
      } catch {
        // silencioso si falla la red
      }
    }

    checkVersion();
    const id = setInterval(checkVersion, POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);
}
