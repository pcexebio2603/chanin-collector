// Colector STANDALONE de precios de Falabella Perú — carril datos del proyecto Chanin.
//
// Falabella NO corre VTEX (plataforma custom Next.js + Cloudflare), por eso este colector
// vive aparte de collect.js/vtex.js/config.js y NO los toca. Reutiliza colector/db.js:
// escribe en la MISMA BD (colector/data/precios.db), mismo esquema, misma lógica de
// "solo cambios" (retailer = 'falabella').
//
// Fuente de datos (verificado 2026-07-13, ver ../../07-decision-falabella.md §2):
//   API JSON del propio front (BFF listing-service), accesible server-side sin evadir nada:
//     GET /s/browse/v1/listing/pe?categoryId=<cat>&categoryName=<n>&pgid=2&pid=<uuid>&page=<n>
//         &zones=<zonas Lima>&latLong=<geo>
//   Params obligatorios: categoryId, pgid=2 (constante = tipo de página listing),
//   pid (id de página VÁLIDO emitido por el servidor — se raspa del HTML de una categoría;
//   un UUID aleatorio es rechazado con 404 "Bad Request"), zones y latLong.
//   La paginación real es el param `page`; `pgid` es constante.
//
// Línea legal (../../02-analisis-competencia.md §6): server-side, sin cuenta, sin evadir
// Cloudflare/CAPTCHAs, rate limit respetuoso, robots.txt honrado (Falabella lo permite:
// "todos los robots son bienvenidos", Disallow vacío salvo carrito/cuenta/checkout).
//
// Uso:
//   node collect-falabella.js                        # todas las categorías, corrida completa
//   node collect-falabella.js --category cat40712    # una sola categoría
//   node collect-falabella.js --max-pages 2          # corrida acotada (prueba)
//   node collect-falabella.js --daily                # salta si ya corrió OK hoy
import crypto from 'node:crypto';
import { openDb, makeWriters, DB_PATH } from '../db.js';

const RETAILER = 'falabella';
const BASE = 'https://www.falabella.com.pe';

// Categorías (id + nombre) de los segmentos donde el historial importa: tecnología,
// electrohogar y línea blanca (mismo criterio que el colector VTEX). Ids mid-level
// verificados 2026-07-13 contra el sitemap de categorías y el endpoint de listing.
// Ampliable: añadir { id, name } (el id sale de la URL /category/<id>/<slug>).
const CATEGORIES = [
  { id: 'cat760706', name: 'Celulares y Telefonos' },
  { id: 'cat270476', name: 'Tablets' },
  { id: 'cat40712', name: 'Laptops' },
  { id: 'cat50678', name: 'Computadoras' },
  { id: 'cat40695', name: 'Monitores' },
  { id: 'cat3180533', name: 'Impresoras' },
  { id: 'cat6370551', name: 'Televisores Smart TV' },
  { id: 'cat210477', name: 'TV Televisores' },
  { id: 'cat800582', name: 'Audifonos' },
  { id: 'cat800584', name: 'Parlantes Bluetooth' },
  { id: 'cat1830468', name: 'Smartwatch y wearables' },
  { id: 'cat13830464', name: 'Consolas PlayStation' },
  { id: 'cat13830465', name: 'Consolas Nintendo' },
  { id: 'cat780530', name: 'Refrigerador' },
  { id: 'cat780532', name: 'Congeladoras' },
  { id: 'cat780522', name: 'Lavadoras' },
  { id: 'cat780524', name: 'Secadora de ropa' },
  { id: 'cat7180470', name: 'Lavadora Secadora' },
  { id: 'cat40691', name: 'Microondas' },
  { id: 'cat40623', name: 'Hornos Electricos' },
  { id: 'cat40674', name: 'Licuadoras' },
  { id: 'cat6370574', name: 'Aspiradoras' },
  // --- Moda y Hogar (añadidas 2026-07-14 para el feature "Caza Precio", ver ../../04-monetizacion.md).
  // Categorías padre mid-level verificadas contra el listing (devuelven el subárbol completo,
  // por eso no hacen falta las subcategorías). El precio de lista/oferta en moda se comparte
  // entre variantes de talla/color, así que no multiplica precios distintos.
  { id: 'cat4100462', name: 'Moda Mujer' },
  { id: 'cat4100481', name: 'Moda Hombre' },
  { id: 'cat7350564', name: 'Ropa de Ninas' },
  { id: 'cat7350562', name: 'Ropa de Ninos' },
  { id: 'cat7350561', name: 'Ropa de Bebe' },
  { id: 'cat1470548', name: 'Zapatillas' },
  { id: 'cat1470526', name: 'Zapatos Mujer' },
  { id: 'cat40700', name: 'Muebles' },
  { id: 'cat50684', name: 'Dormitorio' },
  { id: 'cat250473', name: 'Colchones' },
  { id: 'cat40474', name: 'Decoracion e Iluminacion' },
  { id: 'cat40538', name: 'Cocina' },
  { id: 'cat50588', name: 'Ropa de Cama' },
  { id: 'cat40485', name: 'Closet' },
  { id: 'cat2020476', name: 'Accesorios de Bano' },
  { id: 'cat40685', name: 'Menaje Cocina' },
];

const SETTINGS = {
  delayMs: 600,            // pausa entre requests (más conservador que VTEX: sitio custom + Cloudflare)
  retries: 3,
  retryBaseMs: 2000,       // backoff: 2s, 4s, 8s
  timeoutMs: 30000,
  maxPageHardCap: 150,     // tope de páginas por categoría (~7,200 productos/cat a 48/pág).
                           // Los `count` de Falabella están inflados por marketplace (ej.
                           // "Computadoras 92k" = cables/accesorios/terceros), así que este
                           // tope captura la cabeza real relevante sin perseguir la cola-larga
                           // basura ni disparar el tiempo de corrida. Subir con criterio.
  pgid: '2',               // constante: tipo de página "listing" (no es el número de página)
  // Zona Lima + geo (Miraflores). Estáticos: acotan precio/stock a una zona real.
  zones: '912_LIMA_2,OLVAA_81,LIMA_URB1_DIRECTO,URBANO_83,IBIS_19,912_LIMA_1,150101,PERF_TEST,150000',
  latLong: JSON.stringify({ latitude: '-12.0510554271', longitude: '-77.0490377322' }),
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  // pid de respaldo si no se logra raspar uno fresco del HTML (id de página estable observado
  // 2026-07-13; si Falabella lo rota, el raspado dinámico lo reemplaza en la corrida).
  fallbackPid: '799c102f-9b4c-44be-a421-23e366a63b82',
};

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyCategory = argOf('--category');
const maxPages = argOf('--max-pages') ? Number(argOf('--max-pages')) : Infinity;
const dailyGuard = args.includes('--daily');

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, accept) {
  let lastErr;
  for (let attempt = 0; attempt <= SETTINGS.retries; attempt++) {
    if (attempt > 0) await sleep(SETTINGS.retryBaseMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': SETTINGS.userAgent, Accept: accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(SETTINGS.timeoutMs),
      });
      if (res.status === 200) return await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} en ${url}`);
        continue; // transitorio: reintentar
      }
      throw new Error(`HTTP ${res.status} en ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const getJson = async (url) => JSON.parse(await fetchText(url, 'application/json'));

// Raspa un pid válido del HTML de una página de categoría. El front embebe la URL del BFF
// con un pid emitido por el servidor; ese pid es aceptado por la API (uno aleatorio no).
async function scrapePid() {
  const seed = CATEGORIES.find((c) => !onlyCategory || c.id === onlyCategory) ?? CATEGORIES[0];
  const url = `${BASE}/falabella-pe/category/${seed.id}/${encodeURIComponent(seed.name.replace(/ /g, '-'))}`;
  try {
    const html = await fetchText(url, 'text/html');
    // El HTML embebe la URL del BFF con los params escapados (& entre ellos), por eso
    // el patrón admite cualquier caracter salvo comilla hasta encontrar el pid.
    const m = html.match(/listing\/pe\?categoryId=[^"]{0,500}?pid=([0-9a-f-]{36})/i);
    if (m) {
      log(`pid raspado del HTML de ${seed.id}: ${m[1]}`);
      return m[1];
    }
    log(`no se halló pid en el HTML de ${seed.id}; uso fallback`);
  } catch (e) {
    log(`fallo raspando pid (${e.message}); uso fallback`);
  }
  return SETTINGS.fallbackPid;
}

function listingUrl(catId, catName, page, pid) {
  const p = new URLSearchParams({
    categoryId: catId,
    categoryName: catName.replace(/ /g, '-'),
    pgid: SETTINGS.pgid,
    pid,
    page: String(page),
    zones: SETTINGS.zones,
    latLong: SETTINGS.latLong,
  });
  return `${BASE}/s/browse/v1/listing/pe?${p.toString()}`;
}

const toNum = (v) => {
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v; // el precio puede venir como ["1,979"]
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Normaliza un producto del listing a una fila del esquema `products`/`price_points`.
function normalize(p, categoryName) {
  const byType = {};
  for (const pr of p.prices ?? []) if (pr.type) byType[pr.type] = toNum(pr.price);
  // online = precio internet/evento que paga cualquiera (sin tarjeta); toma el menor si hay dos.
  const online = [byType.internetPrice, byType.eventPrice].filter((x) => x != null);
  const priceOnline = online.length ? Math.min(...online) : null;
  const priceList = byType.normalPrice ?? null; // precio "normal" tachado (lista)
  if (priceOnline == null) return null; // el esquema exige price_online NOT NULL
  // Precio con tarjeta CMR (equivalente a la Oh! de Oechsle): se guarda como teaser JSON.
  const cardTeaser =
    byType.cmrPrice != null
      ? JSON.stringify({ type: 'cmrPrice', price: byType.cmrPrice, label: 'CMR' })
      : null;
  return {
    retailer: RETAILER,
    product_id: String(p.productId ?? ''),
    sku: String(p.skuId ?? p.productId ?? ''),
    name: p.displayName ?? '',
    brand: p.brand ?? '',
    category: categoryName,
    url: p.url ?? '',
    image: p.mediaUrls?.[0] ?? '',
    price_online: priceOnline,
    price_list: priceList,
    card_teaser: cardTeaser,
    // Sin señal fiable de stock en el listing; los items listados son comprables.
    // in_stock = 1 cuando hay precio online válido.
    in_stock: 1,
  };
}

const toD1 = argOf('--target') === 'd1'; // escribir a Cloudflare D1 (Actions) en vez de SQLite local

async function main() {
  let db = null;
  let saveRow, insertRun, flush, maybeFlush;
  if (toD1) {
    const { makeD1Writer } = await import('../d1-writer.js');
    const w = await makeD1Writer();
    ({ saveRow, insertRun } = w);
    flush = w.flush;
    maybeFlush = w.maybeFlush;
    log(`BD: Cloudflare D1 (${w.loaded.toLocaleString('es-PE')} con estado actual)`);
  } else {
    db = openDb();
    ({ saveRow, insertRun } = makeWriters(db));
    log(`BD: ${DB_PATH}`);
    if (dailyGuard && db.prepare(`SELECT 1 FROM runs WHERE retailer=? AND status='ok' AND products>0 AND date(ts)=date('now') LIMIT 1`).get(RETAILER)) {
      log(`[${RETAILER}] ya corrió OK hoy — saltado (--daily)`);
      db.close();
      return 0;
    }
  }

  const cats = CATEGORIES.filter((c) => !onlyCategory || c.id === onlyCategory);
  if (cats.length === 0) {
    log(`categoría --category ${onlyCategory} no está en la lista`);
    if (db) db.close();
    return 1;
  }

  const pid = await scrapePid();
  await sleep(SETTINGS.delayMs);

  const t0 = Date.now();
  const stats = { categories: cats.length, products: 0, changes: 0, errors: 0 };
  const seenSkus = new Set();
  let fatal = false;

  for (const cat of cats) {
    try {
      let page = 1;
      let lastPage = Infinity;
      let catCount = null;
      for (; page <= Math.min(maxPages, SETTINGS.maxPageHardCap) && page <= lastPage; page++) {
        const data = (await getJson(listingUrl(cat.id, cat.name, page, pid))).data ?? {};
        const results = data.results ?? [];
        if (results.length === 0) break;
        if (catCount == null) {
          const pg = data.pagination ?? {};
          catCount = pg.count;
          if (pg.count && pg.perPage) lastPage = Math.ceil(pg.count / pg.perPage);
        }
        for (const prod of results) {
          const row = normalize(prod, cat.name);
          if (!row || !row.sku) continue;
          if (seenSkus.has(row.sku)) continue; // un producto puede colgar de varias categorías
          seenSkus.add(row.sku);
          stats.products++;
          stats.changes += saveRow(row);
        }
        await sleep(SETTINGS.delayMs);
      }
      log(`[${RETAILER}] ${cat.name} (${cat.id}): ${page - 1} páginas, count=${catCount ?? '?'}`);
      // Volcado incremental: un fallo de escritura cuesta un lote, no la corrida entera.
      if (maybeFlush) await maybeFlush();
    } catch (e) {
      stats.errors++;
      log(`[${RETAILER}] ERROR en categoría ${cat.name} (${cat.id}): ${e.message}`);
    }
  }

  const duration_ms = Date.now() - t0;
  const status = stats.errors === 0 ? 'ok' : stats.products > 0 ? 'parcial' : 'fallo';
  if (status === 'fallo') fatal = true;
  insertRun({ ts: new Date().toISOString(), retailer: RETAILER, ...stats, duration_ms, status });
  log(
    `[${RETAILER}] FIN ${status}: ${stats.products} SKUs vistos, ${stats.changes} cambios guardados, ` +
      `${stats.errors} errores, ${Math.round(duration_ms / 1000)}s`
  );
  if (flush) {
    log('Escribiendo cambios a D1…');
    await flush();
    log('D1 actualizado.');
  }
  if (db) db.close();
  return fatal ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  log(`ERROR FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
