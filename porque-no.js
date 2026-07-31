// ¿Por qué este producto no sale en chanin.pe/ofertas?
//
// Uso:
//   CLOUDFLARE_API_TOKEN=... node porque-no.js --url <url de la ficha>
//   CLOUDFLARE_API_TOKEN=... node porque-no.js --sku 20888776 [--tienda falabella]
//   CLOUDFLARE_API_TOKEN=... node porque-no.js --nombre "Botas Mujer" [--tienda falabella]
//
// Existe porque la pregunta se repite: Pablo encuentra una oferta en la web de una tienda, no la
// ve en el carrusel y hay que averiguar en cuál de los once filtros se cayó. Hacerlo a mano son
// media docena de consultas cada vez.
//
// No responde sí/no: recorre la cadena en orden y dice EN QUÉ ESCALÓN se cayó y con qué número.
import { query } from './d1-client.js';
import { BY_ID, RETAILERS, decodeUrl, FALABELLA_PRIMERA_PARTE } from './schema-v2.js';
import { sqlReferencia } from './referencia.js';

const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const URL_ = arg('--url'); const SKU = arg('--sku'); const NOMBRE = arg('--nombre'); const TIENDA = arg('--tienda');

// Umbrales de ofertas.js. La REFERENCIA ya no se copia: sale de referencia.js, compartida con
// la selección, para que este diagnóstico no pueda explicar descartes de un criterio distinto
// del que publica — que es exactamente lo que pasó el 2026-07-31.
const CAIDA_MIN = 0.30, CAIDA_MAX = 0.85, AHORRO_MINIMO = 2500;

const soles = (c) => (c == null ? '—' : 'S/ ' + (c / 100).toFixed(2));
const ok = (m) => console.log(`   \x1b[32m✓\x1b[0m ${m}`);
const no = (m) => console.log(`   \x1b[31m✗\x1b[0m ${m}`);
const nota = (m) => console.log(`     ${m}`);

// De una url de ficha saca el sku (o el productId si no lo lleva).
function deUrl(u) {
  const fala = u.match(/falabella\.com\.pe\/falabella-pe\/product\/([A-Za-z0-9]+)(?:\/[^/]+)?(?:\/(\d+))?/);
  if (fala) return { tienda: 'falabella', sku: fala[2] ?? null, product_id: fala[1] };
  const vtex = u.match(/https?:\/\/www\.(oechsle\.pe|plazavea\.com\.pe|promart\.pe)\/.*-(\d+)\/p/);
  if (vtex) {
    const t = { 'oechsle.pe': 'oechsle', 'plazavea.com.pe': 'plazavea', 'promart.pe': 'promart' }[vtex[1]];
    return { tienda: t, sku: null, product_id: vtex[2] };
  }
  return null;
}

let donde = '', params = [];
if (URL_) {
  const d = deUrl(URL_);
  if (!d) { console.error('No reconozco esa url.'); process.exit(1); }
  const r = RETAILERS[d.tienda];
  donde = d.sku ? `p.retailer = ${r.id} AND p.sku = ?` : `p.retailer = ${r.id} AND p.product_id = ?`;
  params = [d.sku ?? d.product_id];
} else if (SKU) {
  donde = 'p.sku = ?' + (TIENDA ? ` AND p.retailer = ${RETAILERS[TIENDA].id}` : '');
  params = [SKU];
} else if (NOMBRE) {
  donde = 'p.name LIKE ?' + (TIENDA ? ` AND p.retailer = ${RETAILERS[TIENDA].id}` : '');
  params = [`%${NOMBRE}%`];
} else {
  console.error('Indica --url, --sku o --nombre.'); process.exit(1);
}

const filas = await query(`
  SELECT p.id, p.retailer, p.sku, p.product_id, p.slug, p.name, p.cur_online, p.cur_list,
         p.cur_stock, p.seller, s.name AS vendedor
  FROM products p LEFT JOIN sellers s ON s.id = p.seller
  WHERE ${donde} LIMIT 25
`, params);

if (!filas.length) {
  console.log('\n\x1b[31mNo está en la base.\x1b[0m');
  console.log('Puede ser que su categoría no esté entre las que recolectamos, o que la tienda');
  console.log('dejara de listarlo. Sin dato propio no hay historial y por tanto no hay oferta.');
  process.exit(0);
}

// Datos compartidos que hacen falta para el veredicto.
const ids = filas.map((f) => f.id).join(',');
const refs = new Map((await query(`
  WITH ${sqlReferencia({ filtro: `AND product_fk IN (${ids})` })}
  SELECT mp.product_fk, mp.ref AS minimo_previo, md.ref AS mediana, s.ref
  FROM sostenidos s
  JOIN minimo_previo mp ON mp.product_fk = s.product_fk
  JOIN mediana md       ON md.product_fk = s.product_fk
`)).map((r) => [r.product_fk, r]));
const publicadas = new Set((await query(`SELECT product_fk FROM ofertas WHERE product_fk IN (${ids})`)).map((r) => r.product_fk));
const encuarentena = new Map((await query(`SELECT product_fk, motivo FROM cuarentena WHERE product_fk IN (${ids})`)).map((r) => [r.product_fk, r.motivo]));
const puntos = new Map((await query(`SELECT product_fk, COUNT(*) n FROM price_points WHERE product_fk IN (${ids}) GROUP BY product_fk`)).map((r) => [r.product_fk, r.n]));

for (const f of filas) {
  const r = BY_ID[f.retailer];
  console.log(`\n\x1b[1m${f.name}\x1b[0m`);
  console.log(`   ${r.name} · sku ${f.sku} · ${decodeUrl(r, f.product_id, f.slug)}`);
  console.log(`   precio ${soles(f.cur_online)} · lista de la tienda ${soles(f.cur_list)} · ${puntos.get(f.id) ?? 0} puntos de historial`);

  if (publicadas.has(f.id)) { ok('YA ESTÁ en el carrusel.'); continue; }

  const motivo = encuarentena.get(f.id);
  if (motivo) { no(`Apartado por el guardián: ${motivo}`); continue; }

  // 1. stock
  if (f.cur_stock !== 1) { no('Sin stock la última vez que lo vimos — sin stock no es oferta.'); continue; }
  ok('Con stock.');

  // 2. vendedor. Un vendedor nulo NO descalifica: significa que el listado dejó de mostrarlo y
  // aún no sabemos de quién es. Se resuelve leyendo su ficha durante la verificación en vivo.
  if (r.name === 'falabella' && f.vendedor && f.vendedor !== FALABELLA_PRIMERA_PARTE) {
    no(`Lo vende "${f.vendedor}", no Falabella.`);
    nota('Sólo rastreamos lo que fija la propia tienda; Tottus y Sodimac también quedan fuera.');
    continue;
  }
  if (r.name === 'falabella' && !f.vendedor) {
    ok('Vendedor aún desconocido (el listado dejó de mostrarlo); se resuelve al verificar la ficha.');
  } else {
    ok(r.name === 'falabella' ? 'Lo vende Falabella (primera parte).' : 'Retailer sin marketplace.');
  }

  // 3. referencia. Se dice cuál de las dos medidas manda, porque es lo que explica el descarte:
  // si manda la mediana, el precio "rebajado" ya lleva más de la mitad del tiempo y dejó de ser
  // una rebaja; si manda el mínimo previo, el producto ya estuvo así de barato antes.
  const m = refs.get(f.id);
  if (m == null) { no('Sin historial suficiente para calcular una referencia.'); continue; }
  const medida = m.ref;
  const ref = Math.min(medida, f.cur_list || medida);
  const topada = f.cur_list && f.cur_list < medida;
  const manda = m.minimo_previo < m.mediana ? 'el mínimo previo'
              : m.mediana < m.minimo_previo ? 'la mediana ponderada'
              : 'las dos por igual';
  ok(`Referencia ${soles(ref)} — manda ${manda}` +
     ` (mínimo previo ${soles(m.minimo_previo)} · mediana ${soles(m.mediana)})` +
     (topada ? `; la tienda declara ${soles(f.cur_list)} y manda la suya` : ''));

  // 4. ahorro mínimo (sustituyó al piso de precio el 2026-07-28; el porqué, en ofertas.js)
  const ahorro = ref - f.cur_online;
  // El ahorro NEGATIVO merece su propio mensaje: desde que la referencia es el mínimo previo, es
  // el rechazo más frecuente y no es "ahorra poco", es "no ahorra nada". Es el caso del parlante
  // Sony que destapó todo: hoy a S/279 cuando ya se le vio a S/269, anunciado como -72%.
  if (ahorro <= 0) {
    no(`No hay descuento: hoy cuesta ${soles(f.cur_online)} y ya se le vio a ${soles(ref)}.`);
    nota('Si la tienda anuncia una rebaja, es contra un precio anterior que ella misma subió.');
    continue;
  }
  if (ahorro < AHORRO_MINIMO) {
    no(`Sólo ahorra ${soles(ahorro)} y el mínimo son ${soles(AHORRO_MINIMO)}.`);
    nota('El carrusel tiene sitio limitado: un ahorro pequeño no justifica una tarjeta.');
    continue;
  }
  ok(`Ahorra ${soles(ahorro)}.`);

  // 5. banda de caída
  const caida = 1 - f.cur_online / ref;
  const pct = (caida * 100).toFixed(1);
  if (caida < CAIDA_MIN) {
    no(`La caída es del ${pct}% y el mínimo son ${CAIDA_MIN * 100}%.`);
    nota(topada ? 'El descuento que anuncia la tienda es mayor porque parte de un "antes" que ya no sostiene.'
               : 'Contra su propio precio habitual, la rebaja es menor de lo que parece.');
    continue;
  }
  if (caida > CAIDA_MAX) {
    no(`La caída es del ${pct}% y el máximo son ${CAIDA_MAX * 100}%.`);
    nota('Por encima de ese corte casi todo resultó ser referencia inflada, no descuento real.');
    continue;
  }
  ok(`Caída del ${pct}%, dentro de la banda.`);

  no('Pasa todos los filtros de la base: se cayó en la verificación en vivo (agotado o precio');
  nota('distinto al comprobarlo contra la tienda) o en la reverificación de cada 3 horas.');
}
console.log('');
