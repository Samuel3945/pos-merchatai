#!/usr/bin/env bash
# Construye el APK offline del POS directamente desde el código del repo.
#
#   dist/ (build web de producción)  ->  Capacitor  ->  APK con el web bundle
#   embebido. Sin server.url: el WebView carga los assets locales, así el POS
#   abre y opera SIN INTERNET (catálogo cacheado en IndexedDB + cola de ventas).
#
# Requisitos: Node, JDK 17+, Android SDK (ANDROID_SDK_ROOT), Gradle.
# Uso:  VITE_API_URL=https://app.mymerchantai.com bash scripts/build-apk.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API_URL="${VITE_API_URL:-https://app.mymerchantai.com}"
echo "▸ Backend (online): $API_URL"

echo "▸ 1/4 Instalando dependencias…"
npm install

echo "▸ 2/4 Build web de producción…"
VITE_API_URL="$API_URL" npm run build

echo "▸ 3/4 Sincronizando el bundle a Android (Capacitor)…"
if [ ! -d android ]; then
  npx cap add android
else
  npx cap sync android
fi

echo "▸ 4/4 Compilando el APK…"
( cd android && gradle assembleDebug --no-daemon --console=plain )

APK="android/app/build/outputs/apk/debug/app-debug.apk"
echo "✓ APK listo: $APK"
ls -lh "$APK"
