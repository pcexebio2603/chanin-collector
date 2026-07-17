// Backend de escritura a Cloudflare D1 (para correr el colector en GitHub Actions, sin SQLite
// local). Expone la misma interfaz que el writer local (`saveRow`, `insertRun`) + `flush()`.
// Detección de cambios: en memoria, contra `current_prices` (cargada de D1 al inicio).
// Escritura: en lotes al final. El product_fk se resuelve en la propia base con INSERT..SELECT,
// así no hay que pre-consultar ids de productos nuevos.
import { query, exec } from './d1-client.js';
import { cardPrice } from './db.js';

const q = (v) => (v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
const num = (v) => (v == null ? 'NULL' : Number(v));

export async function makeD1Writer() {
  // 1. Cargar current_prices (paginación por keyset, eficiente) a un Map retailer|sku → estado.
  const current = new Map();
  const PAGE = 25000;
  let lastR = '';
  let lastS = '';
  for (;;) {
    const rows = await query(
      `SELECT retailer, sku, product_fk, price_online, price_list, in_stock, card_teaser
       FROM current_prices
       WHERE (retailer > ?) OR (retailer = ? AND sku > ?)
       ORDER BY retailer, sku LIMIT ${PAGE}`,
      [lastR, lastR, lastS]
    );
    for (const r of rows) current.set(r.retailer + '|' + r.sku, r);
    if (rows.length < PAGE) break;
    lastR = rows[rows.length - 1].retailer;
    lastS = rows[rows.length - 1].sku;
  }

  const newProducts = [];
  const changes = [];
  const runs = [];

  const changed = (prev, row) =>
    !prev ||
    prev.price_online !== row.price_online ||
    (prev.price_list ?? null) !== (row.price_list ?? null) ||
    prev.in_stock !== row.in_stock ||
    cardPrice(prev.card_teaser) !== cardPrice(row.card_teaser);

  // Igual firma que el writer local: síncrono, solo acumula, devuelve 1/0.
  function saveRow(row) {
    const key = row.retailer + '|' + row.sku;
    const prev = current.get(key);
    if (!changed(prev, row)) return 0;
    const ts = new Date().toISOString();
    if (!prev) newProducts.push({ row, ts });
    changes.push({ row, ts });
    current.set(key, {
      retailer: row.retailer, sku: row.sku, product_fk: prev?.product_fk ?? null,
      price_online: row.price_online, price_list: row.price_list, in_stock: row.in_stock, card_teaser: row.card_teaser,
    });
    return 1;
  }

  function insertRun(r) {
    runs.push(r);
  }

  async function flush() {
    // Fase 1: productos nuevos (id autogenerado por D1).
    if (newProducts.length) {
      await execChunks(newProducts.map(({ row, ts }) =>
        `INSERT OR IGNORE INTO products (retailer,product_id,sku,name,brand,category,url,image,first_seen,last_checked) ` +
        `VALUES (${q(row.retailer)},${q(row.product_id)},${q(row.sku)},${q(row.name)},${q(row.brand)},${q(row.category)},${q(row.url)},${q(row.image)},${q(ts)},${q(ts)})`
      ));
    }
    // Fase 2: price_points (resuelve product_fk vía SELECT; el producto ya existe tras la fase 1).
    await execChunks(changes.map(({ row, ts }) =>
      `INSERT INTO price_points (product_fk,date,ts,price_online,price_list,card_teaser,in_stock) ` +
      `SELECT id,${q(ts.slice(0, 10))},${q(ts)},${num(row.price_online)},${num(row.price_list)},${q(row.card_teaser)},${row.in_stock} ` +
      `FROM products WHERE retailer=${q(row.retailer)} AND sku=${q(row.sku)}`
    ));
    // Fase 3: current_prices al día.
    await execChunks(changes.map(({ row }) =>
      `INSERT OR REPLACE INTO current_prices (retailer,sku,product_fk,price_online,price_list,in_stock,card_teaser) ` +
      `SELECT retailer,sku,id,${num(row.price_online)},${num(row.price_list)},${row.in_stock},${q(row.card_teaser)} ` +
      `FROM products WHERE retailer=${q(row.retailer)} AND sku=${q(row.sku)}`
    ));
    // Fase 4: bitácora de corridas.
    await execChunks(runs.map((r) =>
      `INSERT INTO runs (ts,retailer,categories,products,changes,errors,duration_ms,status) ` +
      `VALUES (${q(r.ts)},${q(r.retailer)},${num(r.categories)},${num(r.products)},${num(r.changes)},${num(r.errors)},${num(r.duration_ms)},${q(r.status)})`
    ));
  }

  return { saveRow, insertRun, flush, loaded: current.size };
}

async function execChunks(statements, perChunk = 25) {
  for (let i = 0; i < statements.length; i += perChunk) {
    const chunk = statements.slice(i, i + perChunk);
    if (chunk.length) await exec(chunk.join(';\n') + ';');
  }
}
