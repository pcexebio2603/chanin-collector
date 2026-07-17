import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.CHANIN_DB ?? path.join(DIR, 'data', 'precios.db');

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      retailer TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT, brand TEXT, category TEXT, url TEXT, image TEXT,
      first_seen TEXT NOT NULL,
      last_checked TEXT NOT NULL,
      UNIQUE (retailer, sku)
    );
    CREATE TABLE IF NOT EXISTS price_points (
      id INTEGER PRIMARY KEY,
      product_fk INTEGER NOT NULL REFERENCES products(id),
      date TEXT NOT NULL,
      ts TEXT NOT NULL,
      price_online REAL NOT NULL,
      price_list REAL,
      card_teaser TEXT,
      in_stock INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pp_product ON price_points(product_fk, ts);
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      retailer TEXT NOT NULL,
      categories INTEGER, products INTEGER, changes INTEGER, errors INTEGER,
      duration_ms INTEGER, status TEXT
    );
  `);
  return db;
}

// Precio con tarjeta a partir del card_teaser. Falabella lo trae explícito (cmrPrice);
// VTEX guarda una regla de promo sin precio fiable → null (no se inventa).
export function cardPrice(teaser) {
  if (!teaser) return null;
  try {
    const t = typeof teaser === 'string' ? JSON.parse(teaser) : teaser;
    // Cualquier teaser normalizado con precio numérico: cmrPrice (Falabella) u ohPrice (VTEX).
    // El teaser-regla crudo de VTEX no tiene .price → null (no se infiere).
    if (t && typeof t.price === 'number') return t.price;
    return null;
  } catch {
    return null;
  }
}

export function makeWriters(db) {
  const upsertProduct = db.prepare(`
    INSERT INTO products (retailer, product_id, sku, name, brand, category, url, image, first_seen, last_checked)
    VALUES (@retailer, @product_id, @sku, @name, @brand, @category, @url, @image, @now, @now)
    ON CONFLICT (retailer, sku) DO UPDATE SET
      name = excluded.name, url = excluded.url, image = excluded.image, last_checked = excluded.last_checked
    RETURNING id
  `);
  const lastPoint = db.prepare(`
    SELECT price_online, price_list, in_stock, card_teaser FROM price_points
    WHERE product_fk = ? ORDER BY ts DESC LIMIT 1
  `);
  const insertPoint = db.prepare(`
    INSERT INTO price_points (product_fk, date, ts, price_online, price_list, card_teaser, in_stock)
    VALUES (@product_fk, @date, @ts, @price_online, @price_list, @card_teaser, @in_stock)
  `);
  const insertRunStmt = db.prepare(`
    INSERT INTO runs (ts, retailer, categories, products, changes, errors, duration_ms, status)
    VALUES (@ts, @retailer, @categories, @products, @changes, @errors, @duration_ms, @status)
  `);
  const insertRun = (row) => insertRunStmt.run(row);

  // Guarda solo cambios: inserta un punto si es el primero o si difiere del último.
  // Incluye el precio con tarjeta para captar sus cambios aunque el online no cambie.
  const saveRow = db.transaction((row) => {
    const now = new Date().toISOString();
    const { id } = upsertProduct.get({ ...row, now });
    const prev = lastPoint.get(id);
    const changed =
      !prev ||
      prev.price_online !== row.price_online ||
      (prev.price_list ?? null) !== (row.price_list ?? null) ||
      prev.in_stock !== row.in_stock ||
      cardPrice(prev.card_teaser) !== cardPrice(row.card_teaser);
    if (changed) {
      insertPoint.run({
        product_fk: id,
        date: now.slice(0, 10),
        ts: now,
        price_online: row.price_online,
        price_list: row.price_list,
        card_teaser: row.card_teaser,
        in_stock: row.in_stock,
      });
      return 1;
    }
    return 0;
  });

  return { saveRow, insertRun };
}
