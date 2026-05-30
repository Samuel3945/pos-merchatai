// Carritos en espera (multi-cliente). Se guardan en localStorage por dispositivo.
// No interfieren con la cola offline (offline.ts) — esto es solo para pausar
// una venta y atender a otro cliente sin perder el progreso.

export interface ParkedCartItem {
  productId: string;
  name: string;
  price: number;
  qty: number;
  unitType: 'unit' | 'kg';
}

export interface ParkedCart {
  id: string;
  label: string;
  items: ParkedCartItem[];
  total: number;
  parkedAt: string;
}

const KEY = 'tienda_pos_parked_carts_v1';
const MAX_PARKED = 10;

function read(): ParkedCart[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(carts: ParkedCart[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(carts)); } catch {}
}

export function listParked(): ParkedCart[] {
  return read().sort((a, b) => b.parkedAt.localeCompare(a.parkedAt));
}

// Devuelve la siguiente etiqueta secuencial libre: "Cliente 1", "Cliente 2"...
// Indica el orden en que se pausaron las cuentas. Garantiza unicidad.
export function nextClientLabel(): string {
  const taken = new Set(read().map(c => c.label.trim().toLowerCase()));
  for (let n = 1; n <= 999; n++) {
    const candidate = `Cliente ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `Cliente ${Date.now()}`;
}

// Si el label propuesto colisiona con uno existente, agrega un sufijo numérico.
function uniquify(label: string): string {
  const base = label.trim();
  const taken = new Set(read().map(c => c.label.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n <= 999; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})`;
}

export function parkCart(label: string, items: ParkedCartItem[]): ParkedCart | null {
  if (!items.length) return null;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const resolvedLabel = label.trim() ? uniquify(label) : nextClientLabel();
  const cart: ParkedCart = {
    id: `pk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    label: resolvedLabel,
    items: items.map(i => ({ ...i })),
    total,
    parkedAt: new Date().toISOString(),
  };
  const all = read();
  all.push(cart);
  const trimmed = all.sort((a, b) => b.parkedAt.localeCompare(a.parkedAt)).slice(0, MAX_PARKED);
  write(trimmed);
  return cart;
}

export function recallParked(id: string): ParkedCart | null {
  return read().find(c => c.id === id) || null;
}

export function removeParked(id: string): void {
  write(read().filter(c => c.id !== id));
}

export function renameParked(id: string, newLabel: string): void {
  const all = read();
  const base = newLabel.trim();
  if (!base) return;
  const taken = new Set(all.filter(c => c.id !== id).map(c => c.label.trim().toLowerCase()));
  let final = base;
  if (taken.has(final.toLowerCase())) {
    for (let n = 2; n <= 999; n++) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate.toLowerCase())) { final = candidate; break; }
    }
  }
  write(all.map(c => c.id === id ? { ...c, label: final } : c));
}

export function clearAllParked(): void {
  write([]);
}

export function parkedCount(): number {
  return read().length;
}
