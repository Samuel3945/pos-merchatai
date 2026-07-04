# TiendaCajero · Web

POS para navegador. React 18 + Vite + Tailwind. Listo para empaquetar con
Tauri y reutilizar como base de la versión desktop.

## Correr

```bash
npm install
cp .env.example .env   # ajusta VITE_API_URL si tu backend no está en :3000
npm run dev            # http://localhost:5174
```

## Build de producción

```bash
npm run build      # → dist/
npm run preview    # sirve dist/ para probar
```

Despliegue: el `dist/` resultante puede subirse a Vercel, Netlify, S3+CloudFront
o servirse desde cualquier CDN estático. **No requiere servidor propio**;
toda la lógica vive en el software base **MerchantAI** (expone `/api/pos/*`),
configurado vía `VITE_API_URL` (ver `.env.example`).

## APK Android (offline-first)

El POS se empaqueta como APK con **Capacitor**: el `dist/` queda embebido en el
APK y el WebView carga los assets **localmente** (`capacitor://localhost`), así
que el app shell (HTML/JS/CSS + fuentes) abre **sin internet**. Las fuentes están
auto-hospedadas en `public/fonts/` (sin Google Fonts CDN) para que iconos y
tipografía se rendericen offline.

```bash
# Requiere JDK 17+, Android SDK (ANDROID_SDK_ROOT) y Gradle.
VITE_API_URL=https://app.mymerchantai.com bash scripts/build-apk.sh
# → android/app/build/outputs/apk/debug/app-debug.apk
```

**Modelo offline:** el primer arranque necesita internet para el login y para
descargar el catálogo (se cachea en IndexedDB, ver `src/lib/offline.ts`). A
partir de ahí el cajero **vende sin conexión** — el catálogo sale de la caché y
las ventas se **encolan** localmente, sincronizándose solas al volver la red
(badge "En línea / Sin conexión" en la barra del POS).

El proyecto nativo `android/` es regenerable (`npx cap add android`) y está
git-ignorado; la fuente de verdad son `capacitor.config.ts` + `dist/`.

## Estructura

```
src/
├── main.tsx, App.tsx           Entry + router de tres pantallas
├── lib/
│   ├── api.ts                  Cliente HTTP del backend (tipado)
│   ├── storage.ts              Persistencia de la sesión POS (JWT)
│   └── offline.ts              IndexedDB: cache productos + cola ventas
├── hooks/
│   └── usePosLifecycle.ts      Heartbeat 15s + polling de comandos remotos
├── pages/
│   ├── Login.tsx               Pantalla de acceso (display_code + PIN)
│   ├── Pos.tsx                 Catálogo + carrito + cobro
│   └── Locked.tsx              Pantalla cuando el admin bloquea
└── components/
    ├── CheckoutModal.tsx       Multipago + denominaciones + vuelto + fiado
    ├── KgModal.tsx             Producto por peso
    └── QueueModal.tsx          Ventas pendientes de sincronizar
```

## Auth flow

1. El admin crea una caja en `/localcontrol/pos-cajeros` y obtiene
   `display_code` (8 chars, sin O/0/I/1/L) y un PIN de 4 dígitos.
2. El cajero entra esos dos valores en la pantalla de login del Web POS.
3. El backend valida y emite un JWT (HS256, 12h sliding).
4. El JWT se guarda en `localStorage` y se envía como `Authorization: Bearer …`
   en todas las llamadas siguientes.
5. Cada request a un endpoint POS valida que el JWT siga siendo legítimo y que
   la caja siga `active` en BD — si el admin lockea la caja, el JWT deja de
   funcionar en menos de un segundo.

## Comandos remotos del admin → cajero

| Comando | Efecto en el Web POS |
|---|---|
| `lock` | Pantalla "Caja bloqueada" |
| `unlock` | (no-op; el siguiente login funciona) |
| `force_logout` | Cierra sesión y vuelve al login |
| `restart` | `window.location.reload()` |
| `reload_catalog` | Refresca productos al instante |
| `reload_settings` | Refresca settings y métodos de pago |
| `message` | Banner azul con el texto del admin |
| `regenerate_pin` | Cierra sesión (el PIN viejo deja de servir) |
| `kick_session` | Cierra sesión |

Polling cada 4 s al endpoint `/api/pos/pending-commands` (filtrado por
`token_id`). Cada comando se acknowledge para no procesarse dos veces.
