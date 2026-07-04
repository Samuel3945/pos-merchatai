import type { CapacitorConfig } from '@capacitor/cli';

// Empaqueta el POS web (dist/) dentro del APK. Al NO definir `server.url`, el
// WebView carga los assets locales (capacitor://localhost) — el app shell
// funciona 100% sin internet. La lógica de datos offline (IndexedDB: catálogo
// cacheado + cola de ventas en lib/offline.ts) hace el resto.
const config: CapacitorConfig = {
  appId: 'com.merchantai.pos',
  appName: 'Merchant AI Cajero',
  webDir: 'dist',
  android: {
    // Permite que el WebView llame al backend HTTPS de producción cuando SÍ
    // hay red; offline se degrada solo (ventas encoladas).
    allowMixedContent: false,
  },
};

export default config;
