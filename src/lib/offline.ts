// Offline queue for the Web POS — IndexedDB cache for products and pending sales.
// Mirrors the strategy used in the admin POS: cache on every successful fetch,
// queue sales when the network truly fails, sync on reconnect or on demand.

import type { Product, SalePayment } from '../services/api';

const DB_NAME       = 'pos_web_db';
const DB_VERSION    = 1;
const STORE_PRODUCTS = 'products';
const STORE_QUEUE    = 'sales_queue';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
        db.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'localId', autoIncrement: true });
      }
    };
    r.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    r.onerror   = () => reject(r.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    r.onsuccess = () => resolve(r.result as T);
    r.onerror   = () => reject(r.error);
  });
}

// ─── Products cache ─────────────────────────────────────────────────────────

export async function cacheProducts(products: Product[]): Promise<void> {
  const db = await openDB();
  const t  = db.transaction(STORE_PRODUCTS, 'readwrite');
  const s  = t.objectStore(STORE_PRODUCTS);
  s.clear();
  for (const p of products) s.put(p);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
  });
}

export async function getCachedProducts(): Promise<Product[]> {
  const db = await openDB();
  return tx<Product[]>(db, STORE_PRODUCTS, 'readonly', (s) => s.getAll());
}

// ─── Sale queue ─────────────────────────────────────────────────────────────

export interface QueuedSale {
  localId?:    number;
  items:       Array<{ productId: string; qty: number }>;
  paymentType: string;
  payments?:   SalePayment[];
  notes?:      string;
  // Manual credit due date ('YYYY-MM-DD') for offline credito sales; replayed on sync.
  dueDate?:    string | null;
  total:       number;
  queuedAt:    string;
}

export async function queueSale(sale: Omit<QueuedSale, 'localId' | 'queuedAt'>): Promise<IDBValidKey> {
  const db = await openDB();
  const entry: QueuedSale = { ...sale, queuedAt: new Date().toISOString() };
  return tx<IDBValidKey>(db, STORE_QUEUE, 'readwrite', (s) => s.add(entry));
}

export async function getQueuedSales(): Promise<QueuedSale[]> {
  const db = await openDB();
  return tx<QueuedSale[]>(db, STORE_QUEUE, 'readonly', (s) => s.getAll());
}

export async function removeFromQueue(localId: number): Promise<void> {
  const db = await openDB();
  await tx<undefined>(db, STORE_QUEUE, 'readwrite', (s) => s.delete(localId));
}

// ─── Sync queue ─────────────────────────────────────────────────────────────

export async function syncQueue(
  send:    (sale: QueuedSale) => Promise<unknown>,
  onSynced:(localId: number) => void,
  onError: (localId: number, err: string) => void,
): Promise<void> {
  const queued = await getQueuedSales();
  for (const sale of queued) {
    try {
      await send(sale);
      await removeFromQueue(sale.localId!);
      onSynced(sale.localId!);
    } catch (e: any) {
      onError(sale.localId!, e?.message || 'Error al sincronizar');
    }
  }
}
