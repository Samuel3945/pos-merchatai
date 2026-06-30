import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, Product, PaymentMethod, SalePayment } from '../services/api';
import type { PosSession } from '../lib/storage';
import CheckoutModal from '../components/CheckoutModal';
import {
  cacheProducts, getCachedProducts, queueSale, getQueuedSales,
  syncQueue, removeFromQueue, QueuedSale,
} from '../lib/offline';
import {
  listParked, parkCart, removeParked, renameParked, nextClientLabel, ParkedCart,
} from '../lib/parkedCarts';
import { useLowStockThreshold } from '../lib/useThresholds';

const cop = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('es-CO')}`;

// A network failure surfaces in two shapes: the WebView fetch throws a TypeError
// ("Failed to fetch"), while CapacitorHttp (native requests, used to bypass CORS
// in the APK) rejects with a host/connection error string such as
// "Unable to resolve host ...: No address associated with hostname".
// Treat both as "offline" so a sale is queued locally instead of erroring out.
function isNetworkError(e: any): boolean {
  if (e instanceof TypeError) return true;
  const msg = String(e?.message ?? e ?? '').toLowerCase();
  return /unable to resolve host|no address associated|failed to connect|network|timed? ?out|\bconnection\b|offline|err_internet|err_network|err_name_not_resolved|enotfound/.test(msg);
}

interface CartItem {
  productId: string;
  name: string;
  price: number;
  qty: number;         // units or kg
  unitType: 'unit' | 'kg';
}

// Wholesale pricing: pick the best tier the quantity qualifies for (highest
// min_qty that is <= qty); otherwise the base price. Tiers come from the
// product form in the admin ("Venta al por mayor").
function unitPriceFor(product: Product, qty: number): number {
  const base = Number(product.price);
  if (!product.is_wholesale || !Array.isArray(product.wholesale_tiers)) return base;
  let best = base;
  let bestMin = 0;
  for (const t of product.wholesale_tiers) {
    const min = Number(t.min_qty);
    const price = Number(t.price);
    if (Number.isFinite(min) && Number.isFinite(price) && price > 0 && qty >= min && min > bestMin) {
      best = price;
      bestMin = min;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Teclado numérico compartido (modal de peso)
// ─────────────────────────────────────────────────────────────────────────────
function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
  return (
    <div className="grid grid-cols-3 gap-2 mt-3">
      {keys.map(k => (
        <button key={k} onClick={() => onKey(k)}
          className="h-14 rounded-xl border border-line bg-surface-2 text-ink text-xl font-semibold grid place-items-center transition-transform active:scale-[0.96] hover:bg-surface-3">
          {k === 'del'
            ? <span className="material-symbols-outlined text-[20px] text-ink-3">backspace</span>
            : k}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal de peso (productos por KG) — teclado + pesos rápidos + subtotal en vivo
// ─────────────────────────────────────────────────────────────────────────────
function KgModal({
  product, maxKg, onConfirm, onCancel,
}: { product: Product; maxKg: number; onConfirm: (qty: number) => void; onCancel: () => void }) {
  // 'weight': cashier types kg → shows the price. 'amount': cashier types the
  // money to charge → shows the equivalent weight (e.g. "$5.000 de queso").
  const [mode, setMode] = useState<'weight' | 'amount'>('weight');
  const [val, setVal] = useState('');
  const price = Number(product.price);
  const num = parseFloat(val || '0') || 0;

  // In amount mode the weight is derived from the money: kg = amount / price.
  // Weight is quantized to grams (3 decimals), so the resulting charge can
  // differ from the typed amount by a few pesos — we surface that real charge.
  const rawKg = mode === 'amount' ? (price > 0 ? num / price : 0) : num;
  const kg = parseFloat(rawKg.toFixed(3));
  const charge = kg * price;
  // Block adding more weight than the stock left for this product (unless oversell is allowed).
  const over = kg > maxKg;

  const switchMode = (m: 'weight' | 'amount') => { setMode(m); setVal(''); };

  const onKey = (k: string) => {
    const maxLen = mode === 'amount' ? 7 : 6;
    setVal(v => {
      if (k === 'del') return v.slice(0, -1);
      // Pesos are whole numbers — no decimal point in amount mode.
      if (k === '.') return mode === 'amount' ? v : (v.includes('.') ? v : (v === '' ? '0.' : v + '.'));
      if (v === '0') return k;
      if (v.replace('.', '').length >= maxLen) return v;
      return v + k;
    });
  };

  // Physical/peripheral keyboard support: route key presses through the same
  // onKey logic as the on-screen keypad. Enter confirms, Escape cancels.
  const liveRef = useRef({ onKey, kg, onConfirm, onCancel });
  liveRef.current = { onKey, kg, onConfirm, onCancel };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = liveRef.current;
      if (e.key === 'Escape') { s.onCancel(); return; }
      if (e.key === 'Enter') { if (s.kg > 0) s.onConfirm(s.kg); return; }
      if (e.key === 'Backspace') { e.preventDefault(); s.onKey('del'); return; }
      if (e.key === ',' || e.key === '.') { s.onKey('.'); return; }
      if (e.key.length === 1 && e.key >= '0' && e.key <= '9') s.onKey(e.key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const quick = mode === 'amount' ? ['1000', '2000', '5000', '10000'] : ['0.25', '0.5', '1', '2'];

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-surface border border-line rounded-[22px] w-full max-w-sm p-5 shadow-token3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-11 h-11 rounded-xl grid place-items-center bg-surface-2 border border-line text-ink-3 shrink-0">
              <span className="material-symbols-outlined">scale</span>
            </span>
            <div className="min-w-0">
              <div className="text-[17px] font-semibold truncate">{product.name}</div>
              <div className="text-[13px] text-ink-3">{cop(price)} / kg · {Number(product.stock)} kg disp.</div>
            </div>
          </div>
          <button onClick={onCancel} className="w-9 h-9 grid place-items-center rounded-lg bg-surface-2 text-ink-2 hover:text-ink shrink-0">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Mode toggle: type the weight, or type the money to charge. */}
        <div className="grid grid-cols-2 gap-2 mt-4 p-1 rounded-xl bg-surface-2 border border-line">
          {([['weight', 'Por peso'], ['amount', 'Por monto']] as const).map(([m, label]) => (
            <button key={m} onClick={() => switchMode(m)}
              className={`h-9 rounded-lg text-[13px] font-semibold transition-colors ${
                mode === m ? 'bg-primary text-white' : 'text-ink-2 hover:text-ink'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-3 p-4 rounded-2xl bg-surface-2 text-center">
          {mode === 'weight' ? (
            <>
              <div className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-ink-3">Peso a agregar</div>
              <div className="font-display font-semibold leading-none tracking-tight mt-1.5">
                <span className="text-[52px] tnum">{val === '' ? '0' : val}</span>
                <span className="text-[22px] text-ink-3 ml-1.5">kg</span>
              </div>
              <div className="text-[18px] font-bold text-primary mt-2 tnum">{cop(charge)}</div>
            </>
          ) : (
            <>
              <div className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-ink-3">Monto a cobrar</div>
              <div className="font-display font-semibold leading-none tracking-tight mt-1.5 text-primary">
                <span className="text-[52px] tnum">{cop(num)}</span>
              </div>
              <div className="text-[18px] font-bold mt-2 tnum">≈ {kg} kg</div>
              {kg > 0 && charge !== num && (
                <div className="text-[12px] text-ink-3 mt-1 tnum">Cobra {cop(charge)}</div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 mt-3">
          {quick.map(q => (
            <button key={q} onClick={() => setVal(q)}
              className="flex-1 h-10 rounded-xl border border-line bg-surface text-ink-2 text-[13px] font-semibold transition-colors hover:border-primary hover:text-primary">
              {mode === 'amount' ? cop(Number(q)) : `${q}kg`}
            </button>
          ))}
        </div>

        <Keypad onKey={onKey} />

        {over && (
          <div className="mt-3 text-[12.5px] text-danger text-center font-semibold tnum">
            Stock insuficiente · {maxKg} disp.
          </div>
        )}
        <button onClick={() => kg > 0 && !over && onConfirm(kg)} disabled={kg <= 0 || over}
          className="w-full h-14 mt-4 rounded-2xl bg-primary hover:bg-primary-ink disabled:opacity-45 disabled:cursor-not-allowed text-white font-bold text-base flex items-center justify-center gap-2 transition-colors">
          <span className="material-symbols-outlined">add</span>
          Agregar {kg > 0 ? `· ${kg} kg · ${cop(charge)}` : ''}
        </button>
      </div>
    </div>
  );
}

const CATEGORY_ICON: Record<string, string> = {
  'Bebidas': 'local_drink', 'Lácteos': 'egg', 'Panadería': 'bakery_dining',
  'Granos y Legumbres': 'grain', 'Aceites y Grasas': 'oil_barrel',
  'Aseo del Hogar': 'cleaning_services', 'Cuidado Personal': 'face',
  'Carnes y Embutidos': 'kebab_dining', 'Frutas y Verduras': 'nutrition',
  'Snacks y Pasabocas': 'cookie', 'Confitería y Dulces': 'icecream',
  'Cigarrillos': 'smoking_rooms', 'Licores': 'liquor',
  'Granos': 'grain', 'Aceites': 'oil_barrel',
  'default': 'shopping_basket',
};
function catIcon(cat: string | null) {
  return (cat && CATEGORY_ICON[cat]) || CATEGORY_ICON.default;
}

interface Props {
  session: PosSession;
  onLogout: () => void;
}

export default function Pos({ session, onLogout }: Props) {
  const [query, setQuery] = useState('');
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [results, setResults] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showCart, setShowCart] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<'ok' | 'err' | null>(null);
  // Asumimos conexión por defecto — solo cambiamos a offline cuando el evento dispara explícitamente.
  // navigator.onLine es poco confiable al montar (a veces dice false brevemente).
  const [online, setOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [kgProduct, setKgProduct] = useState<Product | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [showCheckout, setShowCheckout] = useState(false);
  const [creditoEnabled, setCreditoEnabled] = useState(false);
  const [einvoiceEnabled, setEinvoiceEnabled] = useState(false);
  const [creditoTermDays, setCreditoTermDays] = useState(30);
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(true);
  // Per-caja: when true this device sells without stock control — products at
  // stock 0 stay sellable (used while loading inventory in a new shop).
  const [allowOversell, setAllowOversell] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [queuedSales, setQueuedSales] = useState<QueuedSale[]>([]);
  const [queueErrors, setQueueErrors] = useState<Record<number, string>>({});
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [productCache, setProductCache] = useState<Record<string, Product>>({});
  const [parkedCarts, setParkedCarts] = useState<ParkedCart[]>([]);
  const [showParked, setShowParked] = useState(false);
  const [showParkPrompt, setShowParkPrompt] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [unitFilter, setUnitFilter] = useState<'all' | 'unit' | 'kg'>('all');
  // null = sin confirmar aún (primer carga), false = cerrada, true = abierta
  const [cashOpen, setCashOpen] = useState<boolean | null>(null);
  // Filtro por característica del producto: `${key}|${value}` o 'all'.
  const [attrFilter, setAttrFilter] = useState<string>('all');
  const lowStockThreshold = useLowStockThreshold();
  const searchRef = useRef<HTMLInputElement>(null);
  // Re-focus the search box so a USB barcode scanner keeps typing into it.
  // Skip on touch devices, where a programmatic focus just pops up the on-screen
  // keyboard (mobile users scan with the camera, not a USB reader). The keyboard
  // still opens when the user taps the search box themselves.
  const focusSearch = useCallback(() => {
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    searchRef.current?.focus();
  }, []);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const refreshParked = () => setParkedCarts(listParked());

  useEffect(() => {
    const up = () => { setOnline(true); triggerSync(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadFromServer();
    refreshQueueCount();
    // Siempre intentamos drenar la cola al montar — el sync se hace fetch real,
    // si la red está caída de verdad, syncQueue captura el error y no pasa nada.
    triggerSync();
    refreshParked();
    focusSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresco periódico — mantiene stock + métodos de pago + flags al día sin
  // forzar al cajero a recargar la página manualmente.
  useEffect(() => {
    const id = setInterval(() => { loadFromServer(); }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abrir/cerrar la caja ocurre en la pestaña Caja (otro componente). Como Pos
  // queda siempre montado, escuchamos este evento para re-evaluar la caja al
  // instante en vez de esperar el refresco de 30s o un toque manual.
  useEffect(() => {
    const onCashChanged = () => { loadFromServer(); };
    window.addEventListener('pos:cash-changed', onCashChanged);
    return () => window.removeEventListener('pos:cash-changed', onCashChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /api/pos/me devuelve catálogo + paymentMethods + features.creditoEnabled en
  // una sola llamada — es lo que el JWT de dispositivo puede consumir.
  const loadFromServer = async () => {
    try {
      const me = await api.pos.me();
      // El admin cerró la sesión de la caja → desloguear al empleado activo
      // (vuelve al selector/PIN) sin perder el token de dispositivo.
      if (me.cashierLocked) {
        window.dispatchEvent(new CustomEvent('pos:cashier-locked'));
        return;
      }
      setAllProducts(me.products);
      setResults(me.products);
      setPaymentMethods(Array.isArray(me.paymentMethods) ? me.paymentMethods : []);
      setCreditoEnabled(!!me.features?.creditoEnabled);
      setEinvoiceEnabled(!!me.features?.einvoiceEnabled);
      setCreditoTermDays(
        typeof (me.store as any)?.creditoTermDays === 'number' ? (me.store as any).creditoTermDays : 30,
      );
      setCanConfirmTransfers(me.features?.canConfirmTransfers !== false);
      setAllowOversell(!!me.features?.allowOversell);
      // Caja abierta: el happy-path lee `cash.cashSessionId` de /pos/me. Pero un
      // backend desplegado más viejo puede no devolver ese campo todavía → ahí el
      // POS quedaba bloqueado en "Caja cerrada" para siempre aunque la caja SÍ
      // estuviera abierta. Antes de bloquear, consultamos el endpoint autoritativo
      // /pos/cash/current (el mismo que usa la pestaña Caja), que siempre devuelve
      // la sesión abierta de la organización.
      let open = !!(me.cash as any)?.cashSessionId;
      if (!open) {
        try {
          const c = await api.cash.current();
          open = !!c.session;
        } catch { /* red caída → mantenemos el último estado conocido abajo */ }
      }
      setCashOpen(open);
      cacheProducts(me.products).catch(() => {});
    } catch {
      // Solo caemos al cache si la red realmente falla.
      const cached = await getCachedProducts();
      setAllProducts(cached); setResults(cached);
    }
  };

  const refreshQueue = async () => {
    const sales = await getQueuedSales();
    setQueuedSales(sales);
    setQueueCount(sales.length);
    // Construir lookup de productos desde cache local (incluye los borrados que aún están cacheados)
    const cached = await getCachedProducts();
    setProductCache(Object.fromEntries(cached.map(p => [p.id, p])));
  };
  const refreshQueueCount = refreshQueue;

  const triggerSync = async () => {
    // Si no hay nada en cola, no llamamos loadFromServer aquí — el caller del
    // useEffect inicial ya lo invoca, y duplicar el GET /me genera 401 doble
    // en consola cuando la sesión está stale.
    const queuedBefore = await getQueuedSales();
    if (queuedBefore.length === 0) return;

    setSyncingQueue(true);
    const errs: Record<number, string> = {};
    await syncQueue(
      async (sale) => {
        const primary = sale.payments && sale.payments.length === 1
          ? sale.payments[0].method
          : (sale.paymentType || 'Efectivo');
        await api.pos.sale(sale.items, primary, sale.notes, sale.payments, session.cash.cashierId, undefined, sale.dueDate);
      },
      () => { /* removeFromQueue is done inside syncQueue */ },
      (localId, err) => { errs[localId] = err; },
    );
    setQueueErrors(errs);
    await refreshQueue();
    setSyncingQueue(false);
    loadFromServer();
  };

  const discardQueuedSale = async (localId: number) => {
    await removeFromQueue(localId);
    setQueueErrors(prev => {
      const next = { ...prev };
      delete next[localId];
      return next;
    });
    await refreshQueue();
  };

  // Recupera una venta encolada cargando sus items al carrito actual.
  // Solo carga items cuyo producto sigue existiendo en el catálogo activo (allProducts).
  // Devuelve cuántos se cargaron y cuántos no existen.
  const loadQueuedToCart = (sale: QueuedSale): { loaded: number; missing: number } => {
    let loaded = 0, missing = 0;
    setCart(prev => {
      const next = [...prev];
      for (const it of sale.items) {
        const live = allProducts.find(p => p.id === it.productId);
        if (!live) { missing++; continue; }
        const ex = next.find(i => i.productId === live.id);
        if (ex) ex.qty = parseFloat((ex.qty + it.qty).toFixed(3));
        else next.push({
          productId: live.id, name: live.name, price: Number(live.price),
          qty: it.qty, unitType: live.unit_type,
        });
        loaded++;
      }
      return next;
    });
    return { loaded, missing };
  };

  const search = useCallback((q: string) => {
    if (!q.trim()) { setResults(allProducts); return; }
    const lower = q.toLowerCase();
    setResults(allProducts.filter(p =>
      p.name.toLowerCase().includes(lower) ||
      (p.barcode && p.barcode.includes(q)) ||
      (p.category && p.category.toLowerCase().includes(lower))
    ));
  }, [allProducts]);

  const handleQuery = (val: string) => {
    setQuery(val);
    clearTimeout(debounceRef.current);
    // Búsqueda local sobre el catálogo que /api/pos/me ya entregó. El cajero
    // no tiene permiso para /api/products?search=, así que filtramos en memoria.
    debounceRef.current = setTimeout(() => search(val), 120);
  };

  const flashBorder = (type: 'ok' | 'err') => {
    setScanFeedback(type); setTimeout(() => setScanFeedback(null), 600);
  };

  const addToCart = (product: Product, qty: number) => {
    // allowOversell: this caja can sell at stock 0 (no stock control), so the
    // out-of-stock guard and the per-unit cap against available stock are skipped.
    if (!allowOversell && product.stock <= 0) { flashBorder('err'); return; }
    setCart(prev => {
      const ex = prev.find(i => i.productId === product.id);
      // Cap the cart against available stock for BOTH unit and weight products.
      if (!allowOversell) {
        const currentQty = ex?.qty ?? 0;
        if (parseFloat((currentQty + qty).toFixed(3)) > Number(product.stock)) { flashBorder('err'); return prev; }
      }
      if (ex) return prev.map(i => {
        if (i.productId !== product.id) return i;
        const newQty = parseFloat((i.qty + qty).toFixed(3));
        return { ...i, qty: newQty, price: unitPriceFor(product, newQty) };
      });
      return [...prev, { productId: product.id, name: product.name, price: unitPriceFor(product, qty), qty, unitType: product.unit_type }];
    });
    flashBorder('ok');
    setQuery(''); setResults(allProducts);
    focusSearch();
  };

  const handleProductClick = (product: Product) => {
    if (!allowOversell && product.stock <= 0) { flashBorder('err'); return; }
    if (product.unit_type === 'kg') {
      setKgProduct(product); // open weight modal
    } else {
      addToCart(product, 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = query.trim();
      // Lookup local de barcode primero; si no hay match exacto, el primer
      // resultado del filtro hace de fallback.
      const exactByBarcode = q ? allProducts.find(p => p.barcode === q) : null;
      const product = exactByBarcode ?? (results.length > 0 ? results[0] : null);
      if (product) handleProductClick(product);
      else flashBorder('err');
    }
    if (e.key === 'Escape') { setQuery(''); setResults(allProducts); }
  };

  const updateQty = (id: string, d: number) =>
    setCart(prev => prev.map(i => {
      if (i.productId !== id) return i;
      const live = allProducts.find(p => p.id === id);
      let newQty = i.unitType === 'unit' ? i.qty + d : parseFloat((i.qty + d * 0.1).toFixed(3));
      // Don't let the stepper push the line past available stock (unless oversell is allowed).
      if (!allowOversell && d > 0 && live && newQty > Number(live.stock)) newQty = Number(live.stock);
      // Re-evaluate wholesale tiers whenever the quantity changes.
      return { ...i, qty: newQty, price: live ? unitPriceFor(live, newQty) : i.price };
    }).filter(i => i.qty > 0));

  // Live text while a cart line's quantity is being typed (null = not editing).
  const [qtyEdit, setQtyEdit] = useState<{ id: string; text: string } | null>(null);

  // Commit a typed cart quantity: parse, clamp, re-evaluate tiers. Empty/≤ 0 removes the line.
  const commitQty = (id: string, raw: string) => {
    setQtyEdit(null);
    const parsed = parseFloat(raw.replace(',', '.'));
    setCart(prev => prev.flatMap(i => {
      if (i.productId !== id) return [i];
      if (!Number.isFinite(parsed) || parsed <= 0) return [];
      const live = allProducts.find(p => p.id === id);
      let newQty = i.unitType === 'unit' ? Math.max(1, Math.round(parsed)) : parseFloat(parsed.toFixed(3));
      // Clamp a typed quantity to available stock (unless oversell is allowed).
      if (!allowOversell && live && newQty > Number(live.stock)) {
        newQty = i.unitType === 'unit' ? Math.floor(Number(live.stock)) : Number(live.stock);
      }
      return [{ ...i, qty: newQty, price: live ? unitPriceFor(live, newQty) : i.price }];
    }));
  };

  // Remove a whole line from the cart in one tap, regardless of its quantity.
  const removeFromCart = (id: string) =>
    setCart(prev => prev.filter(i => i.productId !== id));

  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const itemCount = cart.length;

  // Pausa la venta actual: la guarda en localStorage y limpia el carrito.
  const handleParkCart = (label: string) => {
    if (!cart.length) return;
    const parked = parkCart(label, cart.map(i => ({
      productId: i.productId, name: i.name, price: i.price, qty: i.qty, unitType: i.unitType,
    })));
    if (parked) {
      setCart([]);
      setShowCart(false);
      setShowParkPrompt(false);
      refreshParked();
      setSuccess(`⏸  Venta pausada: ${parked.label}`);
      setTimeout(() => setSuccess(''), 3500);
      focusSearch();
    }
  };

  // Recupera una venta pausada cargando sus ítems al carrito.
  // Solo carga ítems que aún existen en el catálogo activo.
  const handleRecallParked = (parked: ParkedCart) => {
    let loaded = 0, missing = 0;
    setCart(prev => {
      const next = [...prev];
      for (const it of parked.items) {
        const live = allProducts.find(p => p.id === it.productId);
        if (!live) { missing++; continue; }
        const ex = next.find(i => i.productId === live.id);
        if (ex) ex.qty = parseFloat((ex.qty + it.qty).toFixed(3));
        else next.push({
          productId: live.id, name: live.name, price: Number(live.price),
          qty: it.qty, unitType: live.unit_type,
        });
        loaded++;
      }
      return next;
    });
    removeParked(parked.id);
    refreshParked();
    setShowParked(false);
    setSuccess(missing > 0
      ? `↩  ${loaded} ítems cargados (${missing} ya no existen)`
      : `↩  Venta de ${parked.label} reanudada`);
    setTimeout(() => setSuccess(''), 4000);
    focusSearch();
  };

  const handleDiscardParked = (id: string) => {
    removeParked(id);
    refreshParked();
  };

  const completeSaleMixed = async (payments: SalePayment[], notes?: string, dueDate?: string | null) => {
    if (!cart.length) return;
    setLoading(true); setError('');
    const saleItems = cart.map(i => ({ productId: i.productId, qty: i.qty }));
    const primary = payments.length === 1 ? payments[0].method : 'Mixto';

    // Estrategia: siempre intentamos enviar al backend primero. Solo encolamos localmente si
    // realmente no hay red (navigator está offline) o si el fetch falla por TypeError de red.
    try {
      await api.pos.sale(saleItems, primary, notes, payments, session.cash.cashierId, undefined, dueDate);
      loadFromServer();
      const change = payments.reduce((s, p) => s + (p.changeGiven || 0), 0);
      setCart([]); setShowCart(false); setShowCheckout(false);
      setSuccess(change > 0
        ? `✓ Venta completada — ${cop(total)} · Vuelto: ${cop(change)}`
        : `✓ Venta completada — ${cop(total)}`);
      setTimeout(() => setSuccess(''), 4000);
      // Si había cola pendiente, intentar drenarla.
      if (queueCount > 0) triggerSync();
    } catch (e: any) {
      // Solo encolamos cuando fetch realmente falló por red (TypeError "Failed to fetch").
      // navigator.onLine es poco confiable (a veces dice false con conexión activa),
      // así que no lo usamos para decidir si encolar — solo errores reales de red.
      // CapacitorHttp (native requests, used to bypass CORS in the APK) does NOT
      // throw a TypeError when the network is down — it rejects with a native error
      // like "Unable to resolve host ...: No address associated with hostname".
      // Detect both so an offline sale is queued instead of surfacing a raw error.
      const isNetworkErr = isNetworkError(e);
      if (isNetworkErr) {
        await queueSale({ items: saleItems, paymentType: primary, payments, notes, dueDate, total });
        await refreshQueueCount();
        setOnline(false);
        setCart([]); setShowCart(false); setShowCheckout(false);
        setSuccess(`📶 Sin conexión — venta guardada localmente (${cop(total)})`);
        setTimeout(() => setSuccess(''), 5000);
      } else {
        // Error real del servidor (validación, stock, etc.) — no encolamos, mostramos error.
        setError(e.message || 'Error al procesar venta');
        throw e;
      }
    } finally {
      setLoading(false);
      focusSearch();
    }
  };

  // Borde del buscador: refuerzo visual al escanear. Siempre primary con halo.
  const searchBorder = scanFeedback === 'ok'
    ? 'border-success' : scanFeedback === 'err'
    ? 'border-danger' : 'border-primary';

  const CartList = () => (
    <>
      {cart.length === 0 ? (
        <div className="h-full min-h-[180px] flex flex-col items-center justify-center gap-1.5 py-12 text-center">
          <span className="material-symbols-outlined text-3xl text-ink-4 mb-1">shopping_cart</span>
          <div className="font-semibold text-ink-2">Carrito vacío</div>
          <div className="text-[12.5px] text-ink-3">Escanea o toca un producto</div>
        </div>
      ) : cart.map(item => {
        const liveProduct = allProducts.find(p => p.id === item.productId);
        const wholesaleApplied = liveProduct ? item.price < Number(liveProduct.price) : false;
        return (
        <div key={item.productId} className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-0">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{item.name}</div>
            <div className="text-ink-3 text-xs flex items-center gap-1.5 tnum">
              {cop(item.price)} {item.unitType === 'kg' ? '/ kg' : 'c/u'}
              {wholesaleApplied && (
                <span className="px-1.5 py-px rounded-full bg-primary-soft text-primary text-[10px] font-bold">
                  Mayoreo
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5 bg-surface-2 rounded-lg p-0.5">
            <button onClick={() => { setQtyEdit(null); updateQty(item.productId, -1); }}
              className="w-7 h-7 rounded-md bg-surface hover:bg-primary-soft hover:text-primary text-ink flex items-center justify-center font-bold shadow-token2 transition-colors">−</button>
            <input
              type="text"
              inputMode={item.unitType === 'kg' ? 'decimal' : 'numeric'}
              aria-label={`Cantidad ${item.name}`}
              value={qtyEdit?.id === item.productId
                ? qtyEdit.text
                : (item.unitType === 'kg' ? `${Number(item.qty)}` : String(Math.round(Number(item.qty))))}
              onFocus={e => { setQtyEdit({ id: item.productId, text: item.unitType === 'kg' ? `${Number(item.qty)}` : String(Math.round(Number(item.qty))) }); e.currentTarget.select(); }}
              onChange={e => {
                const t = e.target.value;
                const ok = item.unitType === 'kg' ? /^\d*[.,]?\d*$/.test(t) : /^\d*$/.test(t);
                if (ok) setQtyEdit({ id: item.productId, text: t });
              }}
              onBlur={e => commitQty(item.productId, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              className="min-w-[2.25rem] w-12 text-center font-bold text-sm tnum bg-transparent outline-none rounded-md focus:bg-surface focus:ring-1 focus:ring-primary"
            />
            <button onClick={() => { setQtyEdit(null); updateQty(item.productId, 1); }}
              className="w-7 h-7 rounded-md bg-surface hover:bg-primary-soft hover:text-primary text-ink flex items-center justify-center font-bold shadow-token2 transition-colors">+</button>
          </div>
          <div className="w-16 text-right font-bold text-sm tnum">
            {cop(item.price * item.qty)}
          </div>
          <button onClick={() => removeFromCart(item.productId)} title="Eliminar"
            aria-label={`Eliminar ${item.name}`}
            className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:text-danger hover:bg-surface transition-colors shrink-0">
            <span className="material-symbols-outlined text-[18px]">delete</span>
          </button>
        </div>
        );
      })}
    </>
  );

  // Chips de ventas en espera (mockup) — recuperar al tocar, descartar con la x.
  const HeldChips = () => (
    <div className="px-3 py-2.5 border-b border-line bg-surface-2">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="material-symbols-outlined text-[14px] text-warn">schedule</span>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-warn">En espera ({parkedCarts.length})</span>
        <button onClick={() => setShowParked(true)}
          className="ml-auto text-[11px] font-semibold text-ink-3 hover:text-ink">Ver todas</button>
      </div>
      <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-0.5">
        {parkedCarts.map(c => (
          <button key={c.id} onClick={() => handleRecallParked(c)} title="Reanudar venta"
            className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-surface border border-warn/60 text-xs transition-colors hover:bg-warn-soft">
            <span className="font-bold text-warn max-w-[90px] truncate">{c.label}</span>
            <span className="tnum">{cop(c.total)}</span>
            <span className="text-ink-3">{c.items.length} ít.</span>
            <span role="button" onClick={e => { e.stopPropagation(); handleDiscardParked(c.id); }}
              className="grid place-items-center w-4 h-4 rounded text-ink-4 hover:text-danger">
              <span className="material-symbols-outlined text-[12px]">close</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  // Bloquea el POS si la caja está cerrada (esperamos confirmación del servidor)
  if (cashOpen === false) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-5 bg-bg px-6 text-center">
        <span className="material-symbols-outlined text-6xl text-ink-4">lock</span>
        <div>
          <div className="font-extrabold text-xl">Caja cerrada</div>
          <div className="text-ink-3 text-sm mt-1 max-w-xs">
            Para usar el POS necesitas abrir la caja primero.
            Ve a la pestaña <strong className="text-primary">Caja</strong> y abre el turno.
          </div>
        </div>
        <button
          onClick={() => { setCashOpen(null); loadFromServer(); }}
          className="flex items-center gap-2 px-5 h-11 bg-primary-soft hover:bg-primary/20 text-primary font-bold rounded-xl text-sm transition-colors active:scale-95">
          <span className="material-symbols-outlined text-[18px]">refresh</span>
          Verificar de nuevo
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-bg text-ink">
      {/* Checkout modal — mixed payments + change calculator */}
      {showCheckout && (
        <CheckoutModal
          total={total}
          paymentMethods={paymentMethods}
          creditoEnabled={creditoEnabled}
          einvoiceEnabled={einvoiceEnabled}
          canConfirmTransfers={canConfirmTransfers}
          creditoTermDays={creditoTermDays}
          loading={loading}
          onConfirm={completeSaleMixed}
          onCancel={() => setShowCheckout(false)}
        />
      )}

      {/* Queued sales modal */}
      {showQueue && (
        <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-line rounded-[22px] w-full max-w-lg max-h-[85vh] flex flex-col shadow-token3">
            <div className="px-5 py-4 border-b border-line flex items-center justify-between">
              <div>
                <div className="font-bold flex items-center gap-2">
                  <span className="material-symbols-outlined text-warn">sync_problem</span>
                  Ventas pendientes ({queuedSales.length})
                </div>
                <div className="text-ink-3 text-xs mt-0.5">
                  Guardadas localmente sin enviar al servidor
                </div>
              </div>
              <button onClick={() => setShowQueue(false)} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {queuedSales.length === 0 ? (
                <div className="py-12 text-center text-ink-3 text-sm">
                  <span className="material-symbols-outlined text-3xl block mb-2">check_circle</span>
                  No hay ventas pendientes
                </div>
              ) : queuedSales.map(sale => {
                const err = queueErrors[sale.localId!];
                const date = new Date(sale.queuedAt);
                const liveCount = sale.items.filter(it => allProducts.some(p => p.id === it.productId)).length;
                const missingCount = sale.items.length - liveCount;
                return (
                  <div key={sale.localId} className="px-5 py-3 border-b border-line last:border-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-3">
                          <span className="text-primary font-bold tnum">{cop(sale.total)}</span>
                          <span className="text-ink-3 text-xs">{sale.paymentType}</span>
                          <span className="text-ink-3 text-xs">· {sale.items.length} ítem{sale.items.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="text-ink-3 text-xs mt-0.5">
                          {date.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                        {/* Items detail with names from cache */}
                        <ul className="mt-2 space-y-0.5">
                          {sale.items.map((it, idx) => {
                            const cached = productCache[it.productId];
                            const live = allProducts.some(p => p.id === it.productId);
                            return (
                              <li key={idx} className="text-xs flex items-center gap-2">
                                <span className={live ? 'text-success' : 'text-danger'}>
                                  {live ? '●' : '○'}
                                </span>
                                <span className="text-ink-2">
                                  {cached?.name || `(producto eliminado: ${it.productId.slice(0, 8)}…)`}
                                </span>
                                <span className="text-ink-3">× {it.qty}</span>
                              </li>
                            );
                          })}
                        </ul>
                        {err && (
                          <div className="text-danger text-xs bg-danger-soft px-2 py-1 rounded mt-1.5">
                            ⚠ {err}
                          </div>
                        )}
                        {missingCount > 0 && !err && (
                          <div className="text-warn text-xs mt-1.5">
                            ⚠ {missingCount} producto{missingCount > 1 ? 's' : ''} ya no existe{missingCount > 1 ? 'n' : ''} — esta venta no se puede sincronizar
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 flex flex-col gap-1.5">
                        {liveCount > 0 && (
                          <button onClick={() => {
                            const r = loadQueuedToCart(sale);
                            setShowQueue(false);
                            setSuccess(`✓ ${r.loaded} ítem${r.loaded !== 1 ? 's' : ''} cargado${r.loaded !== 1 ? 's' : ''} al carrito${r.missing ? ` (${r.missing} producto(s) ya no existen)` : ''}`);
                            setTimeout(() => setSuccess(''), 5000);
                          }}
                            className="px-3 py-1.5 bg-primary-soft hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition-colors whitespace-nowrap">
                            Cargar al carrito
                          </button>
                        )}
                        <button onClick={() => discardQueuedSale(sale.localId!)}
                          className="px-3 py-1.5 bg-surface-2 hover:bg-danger-soft border border-line hover:border-danger text-danger text-xs font-semibold rounded-lg transition-colors">
                          Descartar
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-5 py-3 border-t border-line flex gap-2">
              <button onClick={triggerSync} disabled={syncingQueue || queuedSales.length === 0}
                className="flex-1 h-11 bg-primary-soft hover:bg-primary/20 disabled:opacity-40 text-primary font-bold rounded-xl transition-colors flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[18px]">sync</span>
                {syncingQueue ? 'Sincronizando…' : 'Reintentar todas'}
              </button>
              <button onClick={() => setShowQueue(false)}
                className="px-4 h-11 bg-surface-2 hover:bg-surface-3 border border-line text-ink-2 font-semibold rounded-xl transition-colors">
                Cerrar
              </button>
            </div>
            {Object.keys(queueErrors).length > 0 && (
              <div className="px-5 pb-3 text-[10px] text-ink-3 leading-snug">
                Las ventas con error suelen referenciar productos que ya no existen en el catálogo.
                Estas no son recuperables — descártalas para limpiar la cola.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Parked carts (cuentas en espera) */}
      {showParked && (
        <ParkedCartsModal
          carts={parkedCarts}
          allProducts={allProducts}
          onRecall={handleRecallParked}
          onDiscard={handleDiscardParked}
          onRename={(id, label) => { renameParked(id, label); refreshParked(); }}
          onClose={() => setShowParked(false)}
        />
      )}

      {/* Park current cart prompt — pide etiqueta del cliente */}
      {showParkPrompt && (
        <ParkCartPrompt
          itemCount={itemCount}
          total={total}
          onConfirm={handleParkCart}
          onCancel={() => setShowParkPrompt(false)}
        />
      )}

      {/* Kg weight modal */}
      {kgProduct && (
        <KgModal
          product={kgProduct}
          maxKg={allowOversell ? Infinity : Math.max(0, Number(kgProduct.stock) - (cart.find(i => i.productId === kgProduct.id)?.qty ?? 0))}
          onConfirm={qty => { addToCart(kgProduct, qty); setKgProduct(null); }}
          onCancel={() => { setKgProduct(null); focusSearch(); }}
        />
      )}

      {/* ── Main: búsqueda + grilla ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="px-4 pt-4 pb-3 shrink-0 space-y-3">
          {/* Buscador / lector */}
          <div className={`relative flex items-center gap-3 h-[54px] px-4 bg-surface border-[1.5px] rounded-2xl transition-colors ${searchBorder}`}
               style={{ boxShadow: '0 0 0 4px rgb(var(--tc-primary) / 0.12)' }}>
            <span className="material-symbols-outlined text-ink-3">barcode_scanner</span>
            <input ref={searchRef} type="text" value={query}
              onChange={e => handleQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Buscar o escanear código de barras…"
              className="flex-1 bg-transparent text-base text-ink placeholder-ink-4"
              autoComplete="off" />
            {query && (
              <button onClick={() => { setQuery(''); setResults(allProducts); focusSearch(); }}
                className="w-6 h-6 grid place-items-center rounded-md text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            )}
            <span className="hidden sm:inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-success-soft text-success text-[11.5px] font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              Lector listo
            </span>
          </div>

          {/* Filtros rápidos: categorías + unidad + características */}
          <CategoryFilterRow
            products={allProducts}
            category={categoryFilter} setCategory={setCategoryFilter}
            unit={unitFilter} setUnit={setUnitFilter}
            attr={attrFilter} setAttr={setAttrFilter}
            categoryFilter={categoryFilter}
          />

          {/* Estado + conteo */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11.5px] font-semibold ${online ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-success' : 'bg-warn'}`} />
              {online ? 'En línea' : 'Sin conexión'}
            </span>
            {queueCount > 0 && (
              <button onClick={() => { refreshQueue(); setShowQueue(true); }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-warn hover:opacity-80">
                <span className="material-symbols-outlined text-[14px]">sync_problem</span>
                {queueCount} venta{queueCount > 1 ? 's' : ''} pendiente{queueCount > 1 ? 's' : ''}
              </button>
            )}
            <span className="text-ink-3 text-xs ml-auto truncate max-w-[160px]">
              {session.cash.label || session.cash.deviceName}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-36 lg:pb-4">
          {success && (
            <div className="mb-3 px-4 py-2.5 bg-success-soft border border-success/40 text-success rounded-xl text-sm font-semibold">
              {success}
            </div>
          )}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]">
            {results
              .filter(p => categoryFilter === 'all' ? true : (p.category || 'Sin categoría') === categoryFilter)
              .filter(p => unitFilter === 'all' ? true : p.unit_type === unitFilter)
              .filter(p => {
                if (attrFilter === 'all') return true;
                const sep = attrFilter.indexOf('|');
                if (sep < 0) return true;
                const k = attrFilter.slice(0, sep);
                const v = attrFilter.slice(sep + 1);
                const attrs = p.attributes ?? {};
                return String(attrs[k] ?? '') === v;
              })
              .map(p => {
                const out = p.stock <= 0;
                const low = !out && p.unit_type === 'unit' && p.stock <= lowStockThreshold(p.id);
                return (
              <button key={p.id} onClick={() => handleProductClick(p)} disabled={out && !allowOversell}
                className="group relative flex flex-col gap-2.5 min-h-[150px] text-left rounded-2xl border border-line bg-surface p-3 transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-token2 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed">
                <div className="flex items-start justify-between">
                  <span className="w-12 h-12 rounded-xl grid place-items-center bg-surface-2 border border-line text-ink-3 group-hover:text-primary transition-colors">
                    <span className="material-symbols-outlined text-[24px]">{catIcon(p.category)}</span>
                  </span>
                  {p.unit_type === 'kg' && (
                    <span className="text-[10px] font-extrabold tracking-wider text-white bg-info px-1.5 py-0.5 rounded-md">KG</span>
                  )}
                </div>
                <div className="text-[13.5px] font-semibold leading-snug flex-1">{p.name}</div>
                <div className="flex items-end justify-between gap-2">
                  {out ? (
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${allowOversell ? 'text-warn' : 'text-danger'}`}>Sin stock</span>
                  ) : p.unit_type === 'kg' ? (
                    <span className="text-[11px] text-ink-3 tnum">{Number(p.stock)} kg disp.</span>
                  ) : low ? (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-warn">Solo {Math.round(Number(p.stock))}</span>
                  ) : (
                    <span className="text-[11px] text-ink-3 tnum">{Math.round(Number(p.stock))} uds</span>
                  )}
                  <span className="text-primary font-bold text-[17px] tnum">
                    {cop(Number(p.price))}{p.unit_type === 'kg' && <small className="text-ink-3 text-[11px] font-semibold ml-0.5">/kg</small>}
                  </span>
                </div>
              </button>
                );
              })}
            {results.length === 0 && (
              <div className="col-span-full py-16 flex flex-col items-center gap-2 text-ink-4">
                <span className="material-symbols-outlined text-4xl">search_off</span>
                Sin resultados
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Carrito (desktop) ─────────────────────────────────────────────── */}
      <aside className="hidden lg:flex w-[clamp(340px,27vw,400px)] flex-col bg-surface border-l border-line">
        <div className="px-4 py-3 border-b border-line flex items-center justify-between">
          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-ink-3">Carrito</div>
            <div className="text-[14.5px] font-semibold mt-0.5">
              {itemCount > 0 ? `${itemCount} ítem${itemCount !== 1 ? 's' : ''}` : 'Cliente mostrador'}
            </div>
          </div>
          {cart.length > 0 && (
            <button onClick={() => setCart([])} title="Vaciar"
              className="w-8 h-8 grid place-items-center rounded-lg text-ink-3 hover:text-danger hover:bg-surface-2 transition-colors">
              <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
            </button>
          )}
        </div>

        {parkedCarts.length > 0 && <HeldChips />}

        <div className="flex-1 overflow-y-auto"><CartList /></div>

        <div className="border-t border-line p-4 bg-surface-2 space-y-3">
          {error && <div className="text-danger text-xs bg-danger-soft border border-danger/40 px-3 py-2 rounded-lg">{error}</div>}
          <button onClick={() => setShowParkPrompt(true)} disabled={!cart.length}
            className="w-full h-11 flex items-center justify-center gap-2 rounded-xl bg-surface border border-line-strong text-warn font-semibold text-[13.5px] transition-colors hover:bg-warn-soft hover:border-warn disabled:opacity-40 disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-surface">
            <span className="material-symbols-outlined text-[18px]">schedule</span>
            Dejar en espera
          </button>
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-semibold">Total</span>
            <span className="font-display font-semibold text-[34px] leading-none tracking-tight tnum">{cop(total)}</span>
          </div>
          <button onClick={() => setShowCheckout(true)} disabled={!cart.length || loading}
            className="w-full h-[60px] rounded-2xl bg-primary hover:bg-primary-ink disabled:opacity-45 disabled:cursor-not-allowed text-white font-bold text-[17px] flex items-center justify-center gap-2.5 transition-colors active:scale-[0.99]">
            <span className="material-symbols-outlined">point_of_sale</span>
            {loading ? 'Procesando…' : `Cobrar ${cart.length ? cop(total) : ''}`}
          </button>
          {!online && <p className="text-warn text-xs text-center">Sin conexión — se guarda localmente</p>}
        </div>
      </aside>

      {/* ── Footer (mobile) ───────────────────────────────────────────────── */}
      <div className="lg:hidden fixed bottom-[57px] left-0 right-0 z-40 bg-surface border-t border-line">
        <div className="flex items-center justify-between px-5 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-ink-3 text-sm font-semibold">Ítems: {itemCount}</span>
            <div className="w-px h-4 bg-line" />
            <button onClick={() => setShowCart(!showCart)} className="text-primary text-sm font-semibold">
              {showCart ? 'Cerrar' : 'Ver carrito'}
            </button>
            {cart.length > 0 && (
              <>
                <div className="w-px h-4 bg-line" />
                <button onClick={() => setShowParkPrompt(true)} className="text-warn text-sm font-semibold flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px]">schedule</span>
                  Esperar
                </button>
              </>
            )}
          </div>
          <span className="font-display font-semibold text-[26px] leading-none tracking-tight tnum">{cop(total)}</span>
        </div>
        {error && <div className="mx-4 mb-2 text-danger text-xs">{error}</div>}
        <button onClick={() => setShowCheckout(true)} disabled={!cart.length || loading}
          className="w-full h-14 bg-primary hover:bg-primary-ink disabled:opacity-45 disabled:cursor-not-allowed text-white font-bold text-sm flex items-center justify-center gap-2 transition-colors">
          <span className="material-symbols-outlined">point_of_sale</span>
          {loading ? 'Procesando…' : 'Cobrar'}
        </button>
      </div>

      {/* ── Cart sheet (mobile) ───────────────────────────────────────────── */}
      {showCart && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setShowCart(false)} />
          <div className="relative bg-surface rounded-t-[22px] border-t border-line max-h-[72vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <span className="font-semibold">Carrito ({itemCount})</span>
              <button onClick={() => setShowCart(false)} className="text-ink-3 hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            {parkedCarts.length > 0 && <HeldChips />}
            <div className="overflow-y-auto"><CartList /></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fila de chips para filtro rápido (categorías + unidad + características)
// Las características solo aparecen al elegir una categoría concreta.
// ─────────────────────────────────────────────────────────────────────────────
function CategoryFilterRow({
  products, category, setCategory, unit, setUnit, attr, setAttr, categoryFilter,
}: {
  products: Product[];
  category: string; setCategory: (c: string) => void;
  unit: 'all' | 'unit' | 'kg'; setUnit: (u: 'all' | 'unit' | 'kg') => void;
  attr: string; setAttr: (a: string) => void;
  categoryFilter: string;
}) {
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) set.add(p.category || 'Sin categoría');
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [products]);

  const hasKg = useMemo(() => products.some(p => p.unit_type === 'kg'), [products]);

  // Características derivadas del subconjunto que ya filtra la categoría activa,
  // para no mostrar atributos irrelevantes.
  const attrGroups = useMemo(() => {
    const subset = categoryFilter === 'all'
      ? products
      : products.filter(p => (p.category || 'Sin categoría') === categoryFilter);
    const groups = new Map<string, Set<string>>();
    for (const p of subset) {
      const attrs = p.attributes ?? {};
      for (const [k, raw] of Object.entries(attrs)) {
        const key = k.trim();
        const val = String(raw ?? '').trim();
        if (!key || !val) continue;
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key)!.add(val);
      }
    }
    return Array.from(groups.entries())
      .map(([k, set]) => ({ key: k, values: Array.from(set).sort((a, b) => a.localeCompare(b, 'es')) }))
      .sort((a, b) => a.key.localeCompare(b.key, 'es'));
  }, [products, categoryFilter]);

  // Si el filtro de característica activo deja de ser válido (cambió la
  // categoría y la característica ya no existe en el subconjunto), lo limpiamos.
  useEffect(() => {
    if (attr === 'all') return;
    const sep = attr.indexOf('|');
    if (sep < 0) { setAttr('all'); return; }
    const k = attr.slice(0, sep), v = attr.slice(sep + 1);
    const exists = attrGroups.some(g => g.key === k && g.values.includes(v));
    if (!exists) setAttr('all');
  }, [attrGroups, attr, setAttr]);

  if (categories.length === 0) return null;

  const pill = (active: boolean) =>
    `shrink-0 h-9 px-4 rounded-xl text-[12.5px] font-bold tracking-[0.02em] whitespace-nowrap transition-colors border ${
      active
        ? 'bg-primary border-primary text-white'
        : 'bg-surface border-line text-ink-2 hover:border-line-strong hover:text-ink'
    }`;

  // Sólo mostramos características cuando hay una categoría concreta seleccionada.
  const showFacets = categoryFilter !== 'all' && attrGroups.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5 scrollbar-thin">
        {hasKg && (
          <>
            <button onClick={() => setUnit(unit === 'unit' ? 'all' : 'unit')}
              className={`shrink-0 h-9 px-3.5 rounded-xl text-[12.5px] font-bold whitespace-nowrap transition-colors border ${
                unit === 'unit' ? 'bg-info border-info text-white' : 'bg-surface border-line text-ink-2 hover:text-ink hover:border-line-strong'
              }`}>
              Por unidad
            </button>
            <button onClick={() => setUnit(unit === 'kg' ? 'all' : 'kg')}
              className={`shrink-0 h-9 px-3.5 rounded-xl text-[12.5px] font-bold whitespace-nowrap transition-colors border ${
                unit === 'kg' ? 'bg-info border-info text-white' : 'bg-surface border-line text-ink-2 hover:text-ink hover:border-line-strong'
              }`}>
              Por kg
            </button>
            <div className="shrink-0 w-px h-6 bg-line mx-0.5" />
          </>
        )}
        <button onClick={() => setCategory('all')} className={pill(category === 'all')}>Todas</button>
        {categories.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)} className={`${pill(category === cat)} inline-flex items-center gap-1.5`}>
            <span className="material-symbols-outlined text-[14px]">{catIcon(cat)}</span>
            {cat}
          </button>
        ))}
      </div>

      {showFacets && (
        <div className="flex items-center gap-2 flex-wrap p-2.5 rounded-xl bg-surface-2 border border-line">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-ink-3 pr-0.5">Características</span>
          <button onClick={() => setAttr('all')}
            className={`h-7 px-3 rounded-full text-[12px] font-semibold transition-colors border ${
              attr === 'all' ? 'bg-accent border-accent text-white' : 'bg-surface border-line text-ink-2 hover:border-line-strong'
            }`}>
            Todas
          </button>
          {attrGroups.flatMap(group => group.values.map(val => {
            const id = `${group.key}|${val}`;
            const active = attr === id;
            return (
              <button key={id} onClick={() => setAttr(active ? 'all' : id)}
                className={`h-7 px-3 rounded-full text-[12px] font-semibold transition-colors border inline-flex items-center gap-1 ${
                  active ? 'bg-accent border-accent text-white' : 'bg-surface border-line text-ink-2 hover:border-line-strong'
                }`}
                title={`${group.key}: ${val}`}>
                <span className={active ? 'text-white/75' : 'text-ink-4'}>{group.key}:</span>
                <span>{val}</span>
              </button>
            );
          }))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal — pausar venta actual (pide etiqueta del cliente)
// ─────────────────────────────────────────────────────────────────────────────
function ParkCartPrompt({
  itemCount, total, onConfirm, onCancel,
}: { itemCount: number; total: number; onConfirm: (label: string) => void; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const suggested = useMemo(() => nextClientLabel(), []);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => onConfirm(label);

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-surface border border-line rounded-[22px] w-full max-w-sm p-5 shadow-token3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-warn-soft flex items-center justify-center">
            <span className="material-symbols-outlined text-warn">schedule</span>
          </div>
          <div>
            <div className="font-bold">Dejar en espera</div>
            <div className="text-ink-3 text-xs tnum">{itemCount} ítem{itemCount !== 1 ? 's' : ''} · {cop(total)}</div>
          </div>
        </div>

        <p className="text-ink-3 text-xs mb-3">
          Si lo dejas vacío, lo guardamos como <span className="text-warn font-semibold">{suggested}</span>. Los nombres son únicos y se enumeran en orden.
        </p>

        <input ref={inputRef} type="text" value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder={suggested}
          className="w-full bg-surface-2 border border-warn/60 rounded-xl px-4 py-3 text-ink focus:border-warn outline-none mb-4" />

        <div className="grid grid-cols-2 gap-2">
          <button onClick={submit}
            className="h-12 bg-warn-soft hover:bg-warn/20 border border-warn/50 text-warn font-bold rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-[18px]">schedule</span>
            En espera
          </button>
          <button onClick={onCancel}
            className="h-12 bg-surface-2 hover:bg-surface-3 border border-line text-ink-2 font-semibold rounded-xl transition-colors">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal — listar y recuperar ventas pausadas
// ─────────────────────────────────────────────────────────────────────────────
function ParkedCartsModal({
  carts, allProducts, onRecall, onDiscard, onRename, onClose,
}: {
  carts: ParkedCart[];
  allProducts: Product[];
  onRecall: (parked: ParkedCart) => void;
  onDiscard: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onClose: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  return (
    <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-[22px] w-full max-w-lg max-h-[85vh] flex flex-col shadow-token3" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <div>
            <div className="font-bold flex items-center gap-2">
              <span className="material-symbols-outlined text-warn">schedule</span>
              Cuentas en espera ({carts.length})
            </div>
            <div className="text-ink-3 text-xs mt-0.5">
              Recupéralas cuando el cliente vuelva o cuando termine de buscar.
            </div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {carts.length === 0 ? (
            <div className="py-12 text-center text-ink-3 text-sm">
              <span className="material-symbols-outlined text-3xl block mb-2">schedule</span>
              No hay ventas pausadas
            </div>
          ) : carts.map(c => {
            const liveCount = c.items.filter(it => allProducts.some(p => p.id === it.productId)).length;
            const missing = c.items.length - liveCount;
            const date = new Date(c.parkedAt);
            return (
              <div key={c.id} className="px-5 py-3 border-b border-line last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {editingId === c.id ? (
                      <div className="flex items-center gap-2">
                        <input autoFocus type="text" value={editLabel}
                          onChange={e => setEditLabel(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { onRename(c.id, editLabel); setEditingId(null); }
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="flex-1 bg-surface-2 border border-warn rounded-lg px-2 py-1 text-ink text-sm" />
                        <button onClick={() => { onRename(c.id, editLabel); setEditingId(null); }}
                          className="text-success hover:opacity-80 text-xs font-bold">OK</button>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingId(c.id); setEditLabel(c.label); }}
                        className="text-left font-bold hover:text-warn flex items-center gap-1">
                        {c.label}
                        <span className="material-symbols-outlined text-[14px] text-ink-4">edit</span>
                      </button>
                    )}
                    <div className="flex items-baseline gap-3 mt-0.5">
                      <span className="text-primary font-bold tnum">{cop(c.total)}</span>
                      <span className="text-ink-3 text-xs">· {c.items.length} ítem{c.items.length !== 1 ? 's' : ''}</span>
                      <span className="text-ink-3 text-xs">· {date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {missing > 0 && (
                      <div className="text-warn text-[11px] mt-1">
                        ⚠ {missing} producto{missing > 1 ? 's' : ''} ya no existe{missing > 1 ? 'n' : ''}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col gap-1.5">
                    {liveCount > 0 && (
                      <button onClick={() => onRecall(c)}
                        className="px-3 py-1.5 bg-primary-soft hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap">
                        <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                        Reanudar
                      </button>
                    )}
                    <button onClick={() => onDiscard(c.id)}
                      className="px-3 py-1.5 bg-surface-2 hover:bg-danger-soft border border-line hover:border-danger text-danger text-xs font-semibold rounded-lg transition-colors">
                      Descartar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-line">
          <button onClick={onClose}
            className="w-full h-11 bg-surface-2 hover:bg-surface-3 border border-line text-ink-2 font-semibold rounded-xl transition-colors">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
