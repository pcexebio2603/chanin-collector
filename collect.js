// Colector diario de precios VTEX — carril datos del proyecto Chanin.
// Escribe siempre a Cloudflare D1: el backend SQLite local se retiró el 2026-07-25, ya que los
// colectores corren en GitHub Actions desde el 2026-07-17 y mantener dos esquemas en paralelo
// sólo generaba divergencia (el local se quedó en el esquema v1).
// Uso:
//   node collect.js                           # los 3 retailers, corrida completa
//   node collect.js --retailer oechsle        # uno solo
//   node collect.js --max-pages 2             # corrida acotada (prueba)
// Requiere CLOUDFLARE_API_TOKEN en el entorno (secret del repo en Actions).
import { RETAILERS } from './config.js';
import { categoryTree, leavesUnder, productsInCategory, normalize } from './vtex.js';
import { makeD1Writer } from './d1-writer.js';

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyRetailer = argOf('--retailer');
const maxPages = argOf('--max-pages') ? Number(argOf('--max-pages')) : Infinity;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const { saveRow, insertRun, flush, maybeFlush, loaded } = await makeD1Writer();
log(`BD: Cloudflare D1 (${loaded.toLocaleString('es-PE')} productos con estado actual)`);

let exitCode = 0;

for (const [retailer, cfg] of Object.entries(RETAILERS)) {
  if (onlyRetailer && retailer !== onlyRetailer) continue;
  const t0 = Date.now();
  const stats = { products: 0, changes: 0, errors: 0, categories: 0 };
  const seenSkus = new Set();
  try {
    const tree = await categoryTree(cfg.base);
    const rootIds = cfg.rootCategories.map((c) => c.id);
    let leaves = leavesUnder(tree, rootIds);
    // Si una raíz no tiene hijos en el árbol, se scrapea la raíz misma.
    if (leaves.length === 0)
      leaves = cfg.rootCategories.map((c) => ({ path: String(c.id), name: c.name }));
    stats.categories = leaves.length;
    log(`[${retailer}] ${leaves.length} categorías hoja bajo ${cfg.rootCategories.map((c) => c.name).join(', ')}`);

    for (const leaf of leaves) {
      try {
        let pages = 0;
        for await (const batch of productsInCategory(cfg.base, leaf.path, { maxPages })) {
          pages++;
          for (const product of batch) {
            for (const row of normalize(product, retailer, cfg.base, leaf.name)) {
              if (seenSkus.has(row.sku)) continue; // un producto puede colgar de varias hojas
              seenSkus.add(row.sku);
              stats.products++;
              stats.changes += saveRow(row);
            }
          }
        }
        if (pages > 0) log(`[${retailer}] ${leaf.name} (${leaf.path}): ${pages} páginas`);
        // Volcado incremental: un fallo de escritura cuesta un lote, no la corrida entera.
        await maybeFlush();
      } catch (e) {
        stats.errors++;
        log(`[${retailer}] ERROR en categoría ${leaf.name} (${leaf.path}): ${e.message}`);
      }
    }
  } catch (e) {
    stats.errors++;
    exitCode = 1;
    log(`[${retailer}] ERROR FATAL: ${e.message}`);
  }
  const duration_ms = Date.now() - t0;
  const status = stats.errors === 0 ? 'ok' : stats.products > 0 ? 'parcial' : 'fallo';
  insertRun({ ts: new Date().toISOString(), retailer, ...stats, duration_ms, status });
  log(
    `[${retailer}] FIN ${status}: ${stats.products} SKUs vistos, ${stats.changes} cambios guardados, ` +
    `${stats.errors} errores, ${Math.round(duration_ms / 1000)}s`
  );
}

log('Escribiendo cambios a D1…');
await flush();
log('D1 actualizado.');
process.exit(exitCode);
