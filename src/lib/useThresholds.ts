// Umbrales de stock bajo. En el panel admin se configuran por producto en
// `app_settings.inventory.low_stock.thresholds`. El JWT del cajero (dispositivo)
// NO puede consultar /api/app-config — eso es admin-only — así que aquí
// devolvemos un fallback fijo. Si en el futuro se expone un endpoint cajero
// (p. ej. /api/pos/thresholds), basta con cambiar la implementación.

const DEFAULT_LOW_STOCK = 5;

export function useLowStockThreshold(): (productId: string) => number {
  return () => DEFAULT_LOW_STOCK;
}
