// Backend de escritura a Cloudflare D1 (para correr el colector en GitHub Actions, sin SQLite
// local). Expone la misma interfaz que el writer local (`saveRow`, `insertRun`) + `flush()`.
// Detección de cambios: en memoria, contra el estado actual que ahora vive en `products`
// (columnas cur_*), no en una tabla `current_prices` aparte.
//
// Escritura INCREMENTAL: se vuelca cada UMBRAL cambios mediante `maybeFlush()`, que el colector
// llama al terminar cada categoría. Antes todo se acumulaba y se escribía en un único flush
// final: el 2026-07-25 ese diseño perdió una corrida entera de 3h26m (16,796 cambios) porque
// la escritura falló al final. Ahora un fallo cuesta como mucho un lote.
import { query, exec } from './d1-client.js';
import {
  RETAILERS, BY_ID, encodeUrl, encodeImage, encodeCard, aCentimos, precioSano, PRECIO_MAX_CENTIMOS,
} from './schema-v2.js';

const q = (v) => (v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
const num = (v) => (v == null ? 'NULL' : Number(v));

const UMBRAL = 5000; // cambios acumulados antes de volcar a D1

export async function makeD1Writer() {
  // 1. Estado actual de todos los productos (paginado por keyset sobre la PK).
  const current = new Map(); // retailer|sku → { id, cur_online, cur_list, cur_stock, cur_card }
  const PAGE = 25000;
  let lastId = 0;
  for (;;) {
    const rows = await query(
      `SELECT id, retailer, sku, cur_online, cur_list, cur_stock, cur_card
       FROM products WHERE id > ? ORDER BY id LIMIT ${PAGE}`,
      [lastId]
    );
    for (const r of rows) current.set(BY_ID[r.retailer].name + '|' + r.sku, r);
    if (rows.length < PAGE) break;
    lastId = rows[rows.length - 1].id;
  }

  // 2. Diccionarios de marcas y categorías (nombre → id).
  const brands = new Map();
  const cats = new Map();
  for (const b of await query('SELECT id, name FROM brands')) brands.set(b.name, b.id);
  for (const c of await query('SELECT id, name FROM categories')) cats.set(c.name, c.id);

  let pendientes = [];
  const runs = [];
  let escritos = 0;
  let descartados = 0;

  // Igual firma que el writer local: síncrono, solo acumula, devuelve 1/0.
  function saveRow(row) {
    const key = row.retailer + '|' + row.sku;
    const prev = current.get(key);
    const online = aCentimos(row.price_online);
    const list = aCentimos(row.price_list);
    const card = encodeCard(row.card_teaser);
    const stock = row.in_stock ? 1 : 0; // normalizado: si no, un boolean nunca casaría con el 0/1 de la base

    // Basura del marketplace: precios imposibles (un "Test Product" de un seller a S/999,999,999,999,
    // almohadas a S/19,000,000). Se descarta el punto entero; si el producto es nuevo, ni se crea.
    // Un producto ya rastreado conserva su último precio sano en vez de envenenar su mín/máx/promedio.
    if (!precioSano(online)) {
      descartados++;
      return 0;
    }

    if (prev && prev.cur_online === online && prev.cur_list === list &&
        prev.cur_stock === stock && prev.cur_card === card) {
      return 0;
    }
    const ts = Math.floor(Date.now() / 1000);
    pendientes.push({ row, ts, esNuevo: !prev, online, list, card, stock });
    current.set(key, {
      id: prev?.id ?? null,
      cur_online: online, cur_list: list, cur_stock: stock, cur_card: card,
    });
    return 1;
  }

  function insertRun(r) {
    runs.push(r);
  }

  // Da de alta los nombres que aún no estén en el diccionario y refresca el mapa con sus ids.
  async function asegurarDiccionario(tabla, mapa, nombres) {
    const nuevos = [...new Set(nombres.filter((n) => n != null && !mapa.has(n)))];
    if (!nuevos.length) return;
    await execChunks(nuevos.map((n) => `INSERT OR IGNORE INTO ${tabla} (name) VALUES (${q(n)})`));
    for (let i = 0; i < nuevos.length; i += 200) {
      const trozo = nuevos.slice(i, i + 200);
      const filas = await query(`SELECT id, name FROM ${tabla} WHERE name IN (${trozo.map(q).join(',')})`);
      for (const f of filas) mapa.set(f.name, f.id);
    }
  }

  async function escribir(lote) {
    if (!lote.length) return;

    // Fase 1: marcas y categorías nuevas (los ids hacen falta para insertar productos).
    await asegurarDiccionario('brands', brands, lote.map((p) => p.row.brand));
    await asegurarDiccionario('categories', cats, lote.map((p) => p.row.category));

    // Fase 2: productos nuevos (id autogenerado por D1; ya nacen con su estado actual).
    const nuevos = lote.filter((p) => p.esNuevo);
    if (nuevos.length) {
      await execChunks(nuevos.map(({ row, ts, online, list, card, stock }) => {
        const r = RETAILERS[row.retailer];
        const slug = encodeUrl(r, row.product_id, row.url);
        const { img_var, img } = encodeImage(r, row.sku, row.image);
        return (
          `INSERT OR IGNORE INTO products ` +
          `(retailer,product_id,sku,name,brand,category,slug,img_var,img,first_seen,last_checked,cur_online,cur_list,cur_stock,cur_card) ` +
          `VALUES (${r.id},${q(row.product_id)},${q(row.sku)},${q(row.name)},` +
          `${num(brands.get(row.brand) ?? null)},${num(cats.get(row.category) ?? null)},` +
          `${q(slug)},${img_var},${q(img)},${ts},${ts},` +
          `${num(online)},${num(list)},${stock},${num(card)})`
        );
      }));
    }

    // Fase 3: price_points. El product_fk se resuelve en la propia base con INSERT..SELECT, así
    // no hay que pre-consultar los ids de los productos recién creados en la fase 2.
    // OR REPLACE protege contra un reintento dentro del mismo segundo (la PK es product_fk+ts).
    await execChunks(lote.map(({ row, ts, online, list, card, stock }) => {
      const r = RETAILERS[row.retailer];
      return (
        `INSERT OR REPLACE INTO price_points (product_fk,ts,price_online,price_list,card_price,in_stock) ` +
        `SELECT id,${ts},${num(online)},${num(list)},${num(card)},${stock} ` +
        `FROM products WHERE retailer=${r.id} AND sku=${q(row.sku)}`
      );
    }));

    // Fase 4: estado actual de los productos que ya existían.
    await execChunks(lote.filter((p) => !p.esNuevo).map(({ row, ts, online, list, card, stock }) => {
      const r = RETAILERS[row.retailer];
      return (
        `UPDATE products SET cur_online=${num(online)},cur_list=${num(list)},` +
        `cur_stock=${stock},cur_card=${num(card)},last_checked=${ts} ` +
        `WHERE retailer=${r.id} AND sku=${q(row.sku)}`
      );
    }));

    escritos += lote.length;
    console.log(`${new Date().toISOString()} [d1] lote de ${lote.length} escrito (${escritos} en total)`);
  }

  // Vuelca solo si ya se acumuló bastante. El colector la llama al cerrar cada categoría.
  async function maybeFlush() {
    if (pendientes.length < UMBRAL) return;
    const lote = pendientes;
    pendientes = [];
    await escribir(lote);
  }

  // Vuelca todo lo que quede, más la bitácora de corridas.
  async function flush() {
    while (pendientes.length) {
      await escribir(pendientes.splice(0, UMBRAL));
    }
    if (runs.length) {
      await execChunks(runs.map((r) =>
        `INSERT INTO runs (ts,retailer,categories,products,changes,errors,duration_ms,status) ` +
        `VALUES (${Math.floor(Date.parse(r.ts) / 1000)},${q(r.retailer)},${num(r.categories)},` +
        `${num(r.products)},${num(r.changes)},${num(r.errors)},${num(r.duration_ms)},${q(r.status)})`
      ));
      runs.length = 0;
    }
    if (descartados) {
      console.log(`${new Date().toISOString()} [d1] ${descartados} puntos descartados por precio imposible (>S/${(PRECIO_MAX_CENTIMOS / 100).toLocaleString('es-PE')})`);
    }
  }

  return { saveRow, insertRun, maybeFlush, flush, loaded: current.size };
}

async function execChunks(statements, perChunk = 25) {
  for (let i = 0; i < statements.length; i += perChunk) {
    const chunk = statements.slice(i, i + perChunk);
    if (chunk.length) await exec(chunk.join(';\n') + ';');
  }
}
