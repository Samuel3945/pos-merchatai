import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

interface Props {
  onScan: (text: string) => void;
  onClose: () => void;
}

// Fullscreen camera overlay that decodes QR codes with jsQR. Uses the rear
// camera when available and scans frames on a requestAnimationFrame loop.
export default function QrScanner({ onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        setError('No se pudo acceder a la cámara. Revisa los permisos del navegador.');
        return;
      }
      const video = videoRef.current;
      if (!video || stopped) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });

      const tick = () => {
        if (stopped) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA && canvas && ctx) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(img.data, img.width, img.height, {
            inversionAttempts: 'dontInvert',
          });
          if (result?.data) {
            stopped = true;
            stream?.getTracks().forEach((t) => t.stop());
            onScan(result.data);
            return;
          }
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="text-white font-bold">Escanear código QR</div>
        <button
          onClick={onClose}
          className="text-ink-3 hover:text-white text-sm px-3 py-1.5 rounded-lg border border-line"
        >
          Cancelar
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />
        {/* Aiming frame */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-64 h-64 rounded-2xl border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
        </div>
        {error && (
          <div className="absolute inset-x-4 bottom-6 bg-danger-soft border border-danger text-danger px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}
        {!error && (
          <div className="absolute inset-x-0 bottom-6 text-center text-ink-3 text-xs">
            Apunta al QR de acceso que genera el administrador
          </div>
        )}
      </div>
    </div>
  );
}
