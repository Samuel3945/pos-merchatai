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

// ─────────────────────────────────────────────────────────────────────────────
// Modal — Fiado (cliente)
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-[#8a9295] text-xs shrink-0">{label}</span>
      <span className={`text-[#e1e2e4] text-sm font-semibold text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
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

// Modal for kg weight input
function KgModal({
  product, onConfirm, onCancel,
}: { product: Product; onConfirm: (qty: number) => void; onCancel: () => void }) {
  const [weight, setWeight] = useState('1');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const handleConfirm = () => {
    const q = parseFloat(weight);
    if (!q || q <= 0) return;
    onConfirm(q);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1E1E1E] border border-[#333333] rounded-2xl w-full max-w-xs p-6 shadow-[0px_8px_24px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-[#9acee1]">scale</span>
          <div>
            <div className="text-[#e1e2e4] font-bold">{product.name}</div>
            <div className="text-[#8a9295] text-xs">${Number(product.price).toLocaleString('es-CO')} / kg</div>
          </div>
        </div>

        <label className="block text-xs text-[#8a9295] font-semibold uppercase tracking-wider mb-1.5">
          Peso (kg)
        </label>
        <input
          ref={inputRef}
          type="number" step="0.01" min="0.01" value={weight}
          onChange={e => setWeight(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') onCancel(); }}
          className="w-full bg-[#121212] border border-[#9acee1] rounded-xl px-4 py-3 text-[#e1e2e4] text-xl font-bold text-center focus:outline-none mb-1"
        />
        {parseFloat(weight) > 0 && (
          <div className="text-center text-[#9acee1] text-sm mb-4">
            Subtotal: ${(parseFloat(weight) * Number(product.price)).toLocaleString('es-CO')}
          </div>
        )}

        {/* Quick weight buttons */}
        <div className="grid grid-cols-4 gap-1.5 mb-4">
          {['0.25', '0.5', '1', '2'].map(w => (
            <button key={w} onClick={() => setWeight(w)}
              className={`h-9 rounded-lg text-sm font-bold transition-colors ${
                weight === w ? 'bg-[#0f4c5c] text-[#9acee1] border border-[#9acee1]' : 'bg-[#282a2b] text-[#c0c8cb] hover:bg-[#333536]'
              }`}>
              {w}kg
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleConfirm}
            disabled={!parseFloat(weight) || parseFloat(weight) <= 0}
            className="h-12 bg-[#12533a] hover:bg-[#1a6b45] disabled:opacity-40 text-[#95d4b3] font-bold rounded-xl transition-colors active:scale-[0.98]">
            Agregar
          </button>
          <button onClick={onCancel}
            className="h-12 bg-[#1d2021] hover:bg-[#282a2b] border border-[#333333] text-[#c0c8cb] font-semibold rounded-xl transition-colors">
            Cancelar
          </button>
        </div>
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
  const [fiadoEnabled, setFiadoEnabled] = useState(false);
  const [fiadoTermDays, setFiadoTermDays] = useState(30);
  const [canConfirmTransfers, setCanConfirmTransfers] = useState(true);
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
    searchRef.current?.focus();
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

  // /api/pos/me devuelve catálogo + paymentMethods + features.fiadoEnabled en
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
      setFiadoEnabled(!!me.features?.fiadoEnabled);
      setFiadoTermDays(
        typeof (me.store as any)?.fiadoTermDays === 'number' ? (me.store as any).fiadoTermDays : 30,
      );
      setCanConfirmTransfers(me.features?.canConfirmTransfers !== false);
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
        await api.pos.sale(sale.items, primary, sale.notes, sale.payments, session.cash.cashierId);
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
    if (product.stock <= 0) { flashBorder('err'); return; }
    setCart(prev => {
      const ex = prev.find(i => i.productId === product.id);
      if (product.unit_type === 'unit') {
        const currentQty = ex?.qty ?? 0;
        if (currentQty + qty > product.stock) { flashBorder('err'); return prev; }
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
    searchRef.current?.focus();
  };

  const handleProductClick = (product: Product) => {
    if (product.stock <= 0) { flashBorder('err'); return; }
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
      const newQty = i.unitType === 'unit' ? i.qty + d : parseFloat((i.qty + d * 0.1).toFixed(3));
      // Re-evaluate wholesale tiers whenever the quantity changes.
      const live = allProducts.find(p => p.id === id);
      return { ...i, qty: newQty, price: live ? unitPriceFor(live, newQty) : i.price };
    }).filter(i => i.qty > 0));

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
      searchRef.current?.focus();
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
    searchRef.current?.focus();
  };

  const handleDiscardParked = (id: string) => {
    removeParked(id);
    refreshParked();
  };

  const completeSaleMixed = async (payments: SalePayment[], notes?: string) => {
    if (!cart.length) return;
    setLoading(true); setError('');
    const saleItems = cart.map(i => ({ productId: i.productId, qty: i.qty }));
    const primary = payments.length === 1 ? payments[0].method : 'Mixto';

    // Estrategia: siempre intentamos enviar al backend primero. Solo encolamos localmente si
    // realmente no hay red (navigator está offline) o si el fetch falla por TypeError de red.
    try {
      await api.pos.sale(saleItems, primary, notes, payments, session.cash.cashierId);
      loadFromServer();
      const change = payments.reduce((s, p) => s + (p.changeGiven || 0), 0);
      setCart([]); setShowCart(false); setShowCheckout(false);
      setSuccess(change > 0
        ? `✓ Venta completada — $${total.toLocaleString('es-CO')} · Vuelto: $${change.toLocaleString('es-CO')}`
        : `✓ Venta completada — $${total.toLocaleString('es-CO')}`);
      setTimeout(() => setSuccess(''), 4000);
      // Si había cola pendiente, intentar drenarla.
      if (queueCount > 0) triggerSync();
    } catch (e: any) {
      // Solo encolamos cuando fetch realmente falló por red (TypeError "Failed to fetch").
      // navigator.onLine es poco confiable (a veces dice false con conexión activa),
      // así que no lo usamos para decidir si encolar — solo errores reales de red.
      const isNetworkErr = e instanceof TypeError;
      if (isNetworkErr) {
        await queueSale({ items: saleItems, paymentType: primary, payments, notes, total });
        await refreshQueueCount();
        setOnline(false);
        setCart([]); setShowCart(false); setShowCheckout(false);
        setSuccess(`📶 Sin conexión — venta guardada localmente ($${total.toLocaleString('es-CO')})`);
        setTimeout(() => setSuccess(''), 5000);
      } else {
        // Error real del servidor (validación, stock, etc.) — no encolamos, mostramos error.
        setError(e.message || 'Error al procesar venta');
        throw e;
      }
    } finally {
      setLoading(false);
      searchRef.current?.focus();
    }
  };

  const borderClass = scanFeedback === 'ok'
    ? 'border-[#95d4b3]' : scanFeedback === 'err'
    ? 'border-[#ffb4ab]' : 'border-[#333333] focus-within:border-[#9acee1]';

  const CartList = () => (
    <>
      {cart.length === 0 ? (
        <div className="py-12 text-center text-[#8a9295] text-sm">
          <span className="material-symbols-outlined text-3xl block mb-2">shopping_cart</span>
          Carrito vacío
        </div>
      ) : cart.map(item => {
        const liveProduct = allProducts.find(p => p.id === item.productId);
        const wholesaleApplied = liveProduct ? item.price < Number(liveProduct.price) : false;
        return (
        <div key={item.productId} className="flex items-center gap-3 px-4 py-3 border-b border-[#333333] last:border-0">
          <div className="flex-1 min-w-0">
            <div className="text-[#e1e2e4] text-sm font-medium truncate">{item.name}</div>
            <div className="text-[#8a9295] text-xs flex items-center gap-1.5">
              ${item.price.toLocaleString('es-CO')} {item.unitType === 'kg' ? '/ kg' : 'c/u'}
              {wholesaleApplied && (
                <span className="px-1.5 py-px rounded-full bg-[#0f4c5c] text-[#9acee1] text-[10px] font-bold">
                  Mayoreo
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => updateQty(item.productId, -1)}
              className="w-7 h-7 rounded-lg bg-[#1d2021] hover:bg-[#282a2b] text-[#e1e2e4] flex items-center justify-center font-bold transition-colors">−</button>
            <span className="min-w-[2.5rem] text-center text-[#e1e2e4] font-bold text-sm">
              {item.unitType === 'kg' ? `${Number(item.qty)}kg` : Math.round(Number(item.qty))}
            </span>
            <button onClick={() => updateQty(item.productId, 1)}
              className="w-7 h-7 rounded-lg bg-[#1d2021] hover:bg-[#282a2b] text-[#e1e2e4] flex items-center justify-center font-bold transition-colors">+</button>
          </div>
          <div className="w-16 text-right text-[#9acee1] font-semibold text-sm">
            ${(item.price * item.qty).toLocaleString('es-CO')}
          </div>
        </div>
        );
      })}
    </>
  );

  // Bloquea el POS si la caja está cerrada (esperamos confirmación del servidor)
  if (cashOpen === false) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-5 bg-[#0a0c0d] px-6 text-center">
        <span className="material-symbols-outlined text-6xl text-[#40484b]">lock</span>
        <div>
          <div className="text-[#e1e2e4] font-black text-xl">Caja cerrada</div>
          <div className="text-[#8a9295] text-sm mt-1 max-w-xs">
            Para usar el POS necesitas abrir la caja primero.
            Ve a la pestaña <strong className="text-[#9acee1]">Caja</strong> y abre el turno.
          </div>
        </div>
        <button
          onClick={() => { setCashOpen(null); loadFromServer(); }}
          className="flex items-center gap-2 px-5 h-11 bg-[#0f4c5c] hover:bg-[#155a6d] text-[#9acee1] font-bold rounded-xl text-sm transition-colors active:scale-95">
          <span className="material-symbols-outlined text-[18px]">refresh</span>
          Verificar de nuevo
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-[#0a0c0d] text-[#e1e2e4]">
      {/* Checkout modal — mixed payments + change calculator */}
      {showCheckout && (
        <CheckoutModal
          total={total}
          paymentMethods={paymentMethods}
          fiadoEnabled={fiadoEnabled}
          canConfirmTransfers={canConfirmTransfers}
          fiadoTermDays={fiadoTermDays}
          loading={loading}
          onConfirm={completeSaleMixed}
          onCancel={() => setShowCheckout(false)}
        />
      )}

      {/* Queued sales modal */}
      {showQueue && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1E1E1E] border border-[#333333] rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-[0px_8px_32px_rgba(0,0,0,0.6)]">
            <div className="px-5 py-4 border-b border-[#333333] flex items-center justify-between">
              <div>
                <div className="text-[#e1e2e4] font-bold flex items-center gap-2">
                  <span className="material-symbols-outlined text-[#ffba27]">sync_problem</span>
                  Ventas pendientes ({queuedSales.length})
                </div>
                <div className="text-[#8a9295] text-xs mt-0.5">
                  Guardadas localmente sin enviar al servidor
                </div>
              </div>
              <button onClick={() => setShowQueue(false)} className="text-[#8a9295] hover:text-[#e1e2e4]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {queuedSales.length === 0 ? (
                <div className="py-12 text-center text-[#8a9295] text-sm">
                  <span className="material-symbols-outlined text-3xl block mb-2">check_circle</span>
                  No hay ventas pendientes
                </div>
              ) : queuedSales.map(sale => {
                const err = queueErrors[sale.localId!];
                const date = new Date(sale.queuedAt);
                const liveCount = sale.items.filter(it => allProducts.some(p => p.id === it.productId)).length;
                const missingCount = sale.items.length - liveCount;
                return (
                  <div key={sale.localId} className="px-5 py-3 border-b border-[#333333] last:border-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-3">
                          <span className="text-[#9acee1] font-bold">${sale.total.toLocaleString('es-CO')}</span>
                          <span className="text-[#8a9295] text-xs">{sale.paymentType}</span>
                          <span className="text-[#8a9295] text-xs">· {sale.items.length} ítem{sale.items.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="text-[#8a9295] text-xs mt-0.5">
                          {date.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                        {/* Items detail with names from cache */}
                        <ul className="mt-2 space-y-0.5">
                          {sale.items.map((it, idx) => {
                            const cached = productCache[it.productId];
                            const live = allProducts.some(p => p.id === it.productId);
                            return (
                              <li key={idx} className="text-xs flex items-center gap-2">
                                <span className={live ? 'text-[#95d4b3]' : 'text-[#ffb4ab]'}>
                                  {live ? '●' : '○'}
                                </span>
                                <span className="text-[#c0c8cb]">
                                  {cached?.name || `(producto eliminado: ${it.productId.slice(0, 8)}…)`}
                                </span>
                                <span className="text-[#8a9295]">× {it.qty}</span>
                              </li>
                            );
                          })}
                        </ul>
                        {err && (
                          <div className="text-[#ffb4ab] text-xs bg-[#93000a]/30 px-2 py-1 rounded mt-1.5">
                            ⚠ {err}
                          </div>
                        )}
                        {missingCount > 0 && !err && (
                          <div className="text-[#ffba27] text-xs mt-1.5">
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
                            className="px-3 py-1.5 bg-[#0f4c5c] hover:bg-[#155a6d] text-[#9acee1] text-xs font-semibold rounded-lg transition-colors whitespace-nowrap">
                            Cargar al carrito
                          </button>
                        )}
                        <button onClick={() => discardQueuedSale(sale.localId!)}
                          className="px-3 py-1.5 bg-[#1d2021] hover:bg-[#93000a]/40 border border-[#333333] hover:border-[#ffb4ab]/50 text-[#ffb4ab] text-xs font-semibold rounded-lg transition-colors">
                          Descartar
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-5 py-3 border-t border-[#333333] flex gap-2">
              <button onClick={triggerSync} disabled={syncingQueue || queuedSales.length === 0}
                className="flex-1 h-11 bg-[#0f4c5c] hover:bg-[#155a6d] disabled:opacity-40 text-[#9acee1] font-bold rounded-xl transition-colors flex items-center justify-center gap-2">
                <span className="material-symbols-outlined text-[18px]">sync</span>
                {syncingQueue ? 'Sincronizando…' : 'Reintentar todas'}
              </button>
              <button onClick={() => setShowQueue(false)}
                className="px-4 h-11 bg-[#1d2021] hover:bg-[#282a2b] border border-[#333333] text-[#c0c8cb] font-semibold rounded-xl transition-colors">
                Cerrar
              </button>
            </div>
            {Object.keys(queueErrors).length > 0 && (
              <div className="px-5 pb-3 text-[10px] text-[#8a9295] leading-snug">
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
          onConfirm={qty => { addToCart(kgProduct, qty); setKgProduct(null); }}
          onCancel={() => { setKgProduct(null); searchRef.current?.focus(); }}
        />
      )}

      {/* ── Cash topbar (distintivo del cajero web) ────────────────────────── */}
      <div className="hidden lg:flex flex-col items-center w-14 bg-[#121212] border-r border-[#333] py-3 gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center"
             style={{ background: session.cash.color || 'linear-gradient(135deg,#9acee1,#95d4b3)' }}>
          <span className="material-symbols-outlined text-[#0a0c0d]">point_of_sale</span>
        </div>
        <div className="flex-1" />
        <button onClick={onLogout} title="Cerrar sesión"
          className="w-9 h-9 flex items-center justify-center text-[#8a9295] hover:text-[#ffb4ab] rounded-lg hover:bg-[#1a1a1a]">
          <span className="material-symbols-outlined text-[20px]">logout</span>
        </button>
      </div>

      {/* Left: search + grid */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="px-4 pt-4 pb-3 shrink-0 space-y-2">
          <div className={`relative flex items-center bg-[#121212] border rounded-xl transition-colors ${borderClass}`}>
            <span className="material-symbols-outlined absolute left-4 text-[#8a9295]">barcode_scanner</span>
            <input ref={searchRef} type="text" value={query}
              onChange={e => handleQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Buscar o escanear código de barras..."
              className="w-full bg-transparent py-3.5 pl-12 pr-4 text-[#e1e2e4] placeholder-[#8a9295] text-base"
              autoComplete="off" />
          </div>
          {/* Filtros rápidos: categorías + unidad + características */}
          <CategoryFilterRow
            products={allProducts}
            category={categoryFilter} setCategory={setCategoryFilter}
            unit={unitFilter} setUnit={setUnitFilter}
            attr={attrFilter} setAttr={setAttrFilter}
            categoryFilter={categoryFilter}
          />
          <div className="flex items-center gap-3 px-1 flex-wrap">
            <div className={`flex items-center gap-1.5 text-xs font-semibold ${online ? 'text-[#95d4b3]' : 'text-[#ffba27]'}`}>
              <span className={`w-2 h-2 rounded-full ${online ? 'bg-[#95d4b3]' : 'bg-[#ffba27]'}`} />
              {online ? 'En línea' : 'Sin conexión'}
            </div>
            {parkedCarts.length > 0 && (
              <button onClick={() => setShowParked(true)}
                className="flex items-center gap-1 text-xs font-bold text-[#ffba27] hover:text-[#e9a700] bg-[#5d4000]/30 hover:bg-[#5d4000]/60 px-2 py-1 rounded-full transition-colors">
                <span className="material-symbols-outlined text-[14px]">pause_circle</span>
                {parkedCarts.length} en espera
              </button>
            )}
            {queueCount > 0 && (
              <button onClick={() => { refreshQueue(); setShowQueue(true); }}
                className="flex items-center gap-1 text-xs text-[#ffba27] hover:text-[#e9a700]">
                <span className="material-symbols-outlined text-[14px]">sync_problem</span>
                {queueCount} venta{queueCount > 1 ? 's' : ''} pendiente{queueCount > 1 ? 's' : ''}
              </button>
            )}
            <span className="text-[#8a9295] text-xs ml-auto">
              {session.cash.label || session.cash.deviceName}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-36">
          {success && (
            <div className="mb-3 px-4 py-2 bg-[#12533a] border border-[#95d4b3] text-[#95d4b3] rounded-xl text-sm font-semibold">
              {success}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
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
              .map(p => (
              <button key={p.id} onClick={() => handleProductClick(p)}
                disabled={p.stock <= 0}
                className="bg-[#1E1E1E] border border-[#333333] rounded-xl p-4 flex flex-col justify-between aspect-square text-left transition-all active:scale-[0.97] hover:border-[#9acee1] group disabled:opacity-40 disabled:cursor-not-allowed relative">
                {/* kg badge */}
                {p.unit_type === 'kg' && (
                  <span className="absolute top-2 right-2 bg-[#0f4c5c] text-[#9acee1] text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider">kg</span>
                )}
                <div className="flex justify-between items-start">
                  <span className="text-[#e1e2e4] font-semibold text-sm leading-tight pr-6">{p.name}</span>
                  <span className="material-symbols-outlined text-[#8a9295] group-hover:text-[#9acee1] transition-colors text-[20px] shrink-0 absolute top-3 right-3 opacity-0 group-hover:opacity-100">
                    {catIcon(p.category)}
                  </span>
                </div>
                <div className="mt-auto">
                  {p.unit_type === 'kg' ? (
                    <span className="text-[10px] font-bold text-[#8a9295] uppercase">
                      {p.stock <= 0 ? 'Sin stock' : `${Number(p.stock)} kg disp.`}
                    </span>
                  ) : (
                    p.stock <= lowStockThreshold(p.id) && p.stock > 0
                      ? <span className="text-[10px] font-bold text-[#ffba27] uppercase">Solo {Math.round(Number(p.stock))}</span>
                      : p.stock <= 0
                      ? <span className="text-[10px] font-bold text-[#ffb4ab] uppercase">Sin stock</span>
                      : null
                  )}
                  <div className="text-right mt-1">
                    <span className="text-[#9acee1] font-bold text-lg">${Number(p.price).toLocaleString('es-CO')}</span>
                    {p.unit_type === 'kg' && <span className="text-[#8a9295] text-[10px] ml-0.5">/kg</span>}
                  </div>
                </div>
              </button>
            ))}
            {results.length === 0 && (
              <div className="col-span-full py-16 text-center text-[#8a9295]">
                <span className="material-symbols-outlined text-4xl block mb-2">search_off</span>
                Sin resultados
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Desktop cart */}
      <div className="hidden lg:flex w-80 flex-col bg-[#121212] border-l border-[#333333]">
        <div className="px-4 py-3 border-b border-[#333333] flex items-center justify-between">
          <span className="font-semibold text-[#e1e2e4]">
            Carrito {itemCount > 0 && <span className="text-[#9acee1]">({itemCount})</span>}
          </span>
          {cart.length > 0 && (
            <div className="flex items-center gap-3">
              <button onClick={() => setShowParkPrompt(true)}
                className="text-xs font-bold text-[#ffba27] hover:text-[#e9a700] flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">pause_circle</span>
                Pausar
              </button>
              <button onClick={() => setCart([])} className="text-xs text-[#8a9295] hover:text-[#ffb4ab]">Vaciar</button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto"><CartList /></div>
        <div className="border-t border-[#333333] p-4 space-y-3">
          {error && <div className="text-[#ffb4ab] text-xs bg-[#93000a]/30 border border-[#93000a]/50 px-3 py-2 rounded-lg">{error}</div>}
          <div className="flex justify-between items-baseline">
            <span className="text-[#8a9295] text-sm font-semibold uppercase tracking-wider">Total</span>
            <span className="text-white font-black text-3xl tracking-tight">${total.toLocaleString('es-CO')}</span>
          </div>
          <button
            onClick={() => setShowCheckout(true)}
            disabled={!cart.length || loading}
            className="w-full h-14 bg-[#12533a] hover:bg-[#1a6b45] disabled:opacity-40 disabled:cursor-not-allowed text-[#95d4b3] font-black text-base rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
            <span className="material-symbols-outlined">point_of_sale</span>
            {loading ? 'Procesando…' : 'Cobrar'}
          </button>
          {!online && <p className="text-[#ffba27] text-xs text-center">Sin conexión — se guarda localmente</p>}
        </div>
      </div>

      {/* Mobile footer */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#121212] border-t border-[#333333]">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[#8a9295] text-sm font-semibold">Items: {itemCount}</span>
            <div className="w-px h-4 bg-[#333333]" />
            <button onClick={() => setShowCart(!showCart)} className="text-[#9acee1] text-sm font-semibold">
              {showCart ? 'Cerrar' : 'Ver carrito'}
            </button>
            {cart.length > 0 && (
              <>
                <div className="w-px h-4 bg-[#333333]" />
                <button onClick={() => setShowParkPrompt(true)} className="text-[#ffba27] text-sm font-semibold flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px]">pause_circle</span>
                  Pausar
                </button>
              </>
            )}
          </div>
          <span className="text-white font-black text-2xl tracking-tight">${total.toLocaleString('es-CO')}</span>
        </div>
        {error && <div className="mx-4 mb-2 text-[#ffb4ab] text-xs">{error}</div>}
        <button onClick={() => setShowCheckout(true)} disabled={!cart.length || loading}
          className="w-full h-14 bg-[#12533a] disabled:opacity-40 disabled:cursor-not-allowed text-[#95d4b3] font-black text-sm flex items-center justify-center gap-2">
          <span className="material-symbols-outlined">point_of_sale</span>
          {loading ? 'Procesando…' : 'Cobrar'}
        </button>
      </div>

      {/* Mobile cart sheet */}
      {showCart && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCart(false)} />
          <div className="relative bg-[#1E1E1E] rounded-t-2xl border-t border-[#333333] max-h-[70vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#333333]">
              <span className="font-semibold text-[#e1e2e4]">Carrito ({itemCount})</span>
              <div className="flex items-center gap-2">
                <button onClick={onLogout} className="text-[#8a9295] hover:text-[#ffb4ab] p-1.5 rounded-lg" title="Cerrar sesión">
                  <span className="material-symbols-outlined text-[20px]">logout</span>
                </button>
                <button onClick={() => setShowCart(false)} className="text-[#8a9295]">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            <div className="overflow-y-auto"><CartList /></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fila de chips para filtro rápido (categorías + unidad + características)
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

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-thin">
        <button onClick={() => setCategory('all')}
          className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors ${
            category === 'all' ? 'bg-[#0f4c5c] text-[#9acee1]' : 'bg-[#1d2021] text-[#8a9295] hover:text-[#c0c8cb]'
          }`}>
          Todas
        </button>
        {categories.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)}
            className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors flex items-center gap-1 ${
              category === cat ? 'bg-[#0f4c5c] text-[#9acee1]' : 'bg-[#1d2021] text-[#8a9295] hover:text-[#c0c8cb]'
            }`}>
            <span className="material-symbols-outlined text-[12px]">{catIcon(cat)}</span>
            {cat}
          </button>
        ))}
        {hasKg && (
          <>
            <div className="shrink-0 w-px h-5 bg-[#2a2a2a] mx-1" />
            <button onClick={() => setUnit(unit === 'unit' ? 'all' : 'unit')}
              className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors ${
                unit === 'unit' ? 'bg-[#3d1c4d] text-[#d4a3ff]' : 'bg-[#1d2021] text-[#8a9295] hover:text-[#c0c8cb]'
              }`}>
              Por unidad
            </button>
            <button onClick={() => setUnit(unit === 'kg' ? 'all' : 'kg')}
              className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors ${
                unit === 'kg' ? 'bg-[#3d1c4d] text-[#d4a3ff]' : 'bg-[#1d2021] text-[#8a9295] hover:text-[#c0c8cb]'
              }`}>
              Por kg
            </button>
          </>
        )}
      </div>

      {attrGroups.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-thin">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[#50575a] pr-1">Características</span>
          <button onClick={() => setAttr('all')}
            className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors ${
              attr === 'all' ? 'bg-[#5d4000]/40 text-[#ffba27]' : 'bg-[#1d2021] text-[#8a9295] hover:text-[#c0c8cb]'
            }`}>
            Todas
          </button>
          {attrGroups.flatMap(group => group.values.map(val => {
            const id = `${group.key}|${val}`;
            const active = attr === id;
            return (
              <button key={id} onClick={() => setAttr(active ? 'all' : id)}
                className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors flex items-center gap-1 ${
                  active ? 'bg-[#5d4000]/40 text-[#ffba27]' : 'bg-[#1d2021] text-[#8a9295] hover:text-[#c0c8cb]'
                }`}
                title={`${group.key}: ${val}`}>
                <span className="opacity-60 normal-case">{group.key}:</span>
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1E1E1E] border border-[#333] rounded-2xl w-full max-w-sm p-5 shadow-[0px_8px_32px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[#5d4000] flex items-center justify-center">
            <span className="material-symbols-outlined text-[#ffba27]">pause_circle</span>
          </div>
          <div>
            <div className="text-[#e1e2e4] font-bold">Pausar venta</div>
            <div className="text-[#8a9295] text-xs">{itemCount} ítem{itemCount !== 1 ? 's' : ''} · ${total.toLocaleString('es-CO')}</div>
          </div>
        </div>

        <p className="text-[#8a9295] text-xs mb-3">
          Si lo dejas vacío, lo guardamos como <span className="text-[#ffba27] font-semibold">{suggested}</span>. Los nombres son únicos y se enumeran en orden.
        </p>

        <input ref={inputRef} type="text" value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder={suggested}
          className="w-full bg-[#121212] border border-[#5d4000] rounded-xl px-4 py-3 text-[#e1e2e4] focus:border-[#ffba27] outline-none mb-4" />

        <div className="grid grid-cols-2 gap-2">
          <button onClick={submit}
            className="h-12 bg-[#5d4000] hover:bg-[#6d4d00] border border-[#ffba27]/40 text-[#ffba27] font-bold rounded-xl transition-colors active:scale-[0.98] flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-[18px]">pause_circle</span>
            Pausar
          </button>
          <button onClick={onCancel}
            className="h-12 bg-[#1d2021] hover:bg-[#282a2b] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl transition-colors">
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1E1E1E] border border-[#333] rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-[0px_8px_32px_rgba(0,0,0,0.6)]">
        <div className="px-5 py-4 border-b border-[#333] flex items-center justify-between">
          <div>
            <div className="text-[#e1e2e4] font-bold flex items-center gap-2">
              <span className="material-symbols-outlined text-[#ffba27]">pause_circle</span>
              Cuentas en espera ({carts.length})
            </div>
            <div className="text-[#8a9295] text-xs mt-0.5">
              Recupéralas cuando el cliente vuelva o cuando termine de buscar.
            </div>
          </div>
          <button onClick={onClose} className="text-[#8a9295] hover:text-[#e1e2e4]">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {carts.length === 0 ? (
            <div className="py-12 text-center text-[#8a9295] text-sm">
              <span className="material-symbols-outlined text-3xl block mb-2">pause_circle</span>
              No hay ventas pausadas
            </div>
          ) : carts.map(c => {
            const liveCount = c.items.filter(it => allProducts.some(p => p.id === it.productId)).length;
            const missing = c.items.length - liveCount;
            const date = new Date(c.parkedAt);
            return (
              <div key={c.id} className="px-5 py-3 border-b border-[#333] last:border-0">
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
                          className="flex-1 bg-[#121212] border border-[#ffba27] rounded-lg px-2 py-1 text-[#e1e2e4] text-sm" />
                        <button onClick={() => { onRename(c.id, editLabel); setEditingId(null); }}
                          className="text-[#95d4b3] hover:text-white text-xs font-bold">OK</button>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingId(c.id); setEditLabel(c.label); }}
                        className="text-left text-[#e1e2e4] font-bold hover:text-[#ffba27] flex items-center gap-1">
                        {c.label}
                        <span className="material-symbols-outlined text-[14px] text-[#40484b]">edit</span>
                      </button>
                    )}
                    <div className="flex items-baseline gap-3 mt-0.5">
                      <span className="text-[#9acee1] font-bold">${c.total.toLocaleString('es-CO')}</span>
                      <span className="text-[#8a9295] text-xs">· {c.items.length} ítem{c.items.length !== 1 ? 's' : ''}</span>
                      <span className="text-[#8a9295] text-xs">· {date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {missing > 0 && (
                      <div className="text-[#ffba27] text-[11px] mt-1">
                        ⚠ {missing} producto{missing > 1 ? 's' : ''} ya no existe{missing > 1 ? 'n' : ''}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col gap-1.5">
                    {liveCount > 0 && (
                      <button onClick={() => onRecall(c)}
                        className="px-3 py-1.5 bg-[#0f4c5c] hover:bg-[#155a6d] text-[#9acee1] text-xs font-semibold rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap">
                        <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                        Reanudar
                      </button>
                    )}
                    <button onClick={() => onDiscard(c.id)}
                      className="px-3 py-1.5 bg-[#1d2021] hover:bg-[#93000a]/40 border border-[#333] hover:border-[#ffb4ab]/50 text-[#ffb4ab] text-xs font-semibold rounded-lg transition-colors">
                      Descartar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-[#333]">
          <button onClick={onClose}
            className="w-full h-11 bg-[#1d2021] hover:bg-[#282a2b] border border-[#333] text-[#c0c8cb] font-semibold rounded-xl transition-colors">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
