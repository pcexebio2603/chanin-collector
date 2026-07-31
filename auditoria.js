// Auto-auditoría de Caza Precio: ¿las ofertas que publicamos eran de verdad?
//
// Uso: CLOUDFLARE_API_TOKEN=... node auditoria.js [--dias 7]
//
// EL MÉTODO. No guardamos un histórico de lo publicado (la tabla `ofertas` se recalcula entera
// en cada corrida), así que la auditoría no espera: RETRO-SIMULA. Se elige un corte T hace N
// días, se calcula qué habría publicado el detector usando SÓLO los datos que existían hasta T,
// y después se mira qué hizo el precio a partir de T.
//
// LA MÉTRICA. Una rebaja de verdad es temporal: el precio vuelve a subir (el análisis del
// 2026-07-24 midió una vida útil de 1-3 días). Si tras publicarla el precio NUNCA regresa cerca
// de la referencia, lo más probable es que esa referencia no fuera el precio habitual del
// producto — que es exactamente el fallo del caso Puma. Así que la tasa de retorno mide si
// nuestras referencias son precios reales.
//
// Se calcula para el algoritmo ACTUAL y para los dos ANTERIORES sobre el mismo corte, de modo que
// la mejora se demuestra en vez de suponerse. La referencia de hoy no se copia aquí: sale de
// referencia.js, la misma que publica ofertas.js — pasándole el corte como "ahora", que es para
// lo que ese módulo admite parámetro. Hasta el 2026-07-31 esta auditoría llamaba "hoy" a la
// mediana ponderada, que para entonces ya no era el criterio: auditaba un algoritmo inexistente.
//
// LÍMITE HONESTO: con ~15 días de historial el corte deja ~8 días antes y 7 después. Una
// liquidación larga y legítima puede no haber vuelto todavía y cuenta como "no volvió", así que
// la tasa es un SUELO, no una medida exacta. Mejora sola conforme se acumule historial.
import { query } from './d1-client.js';
import { FALABELLA_PRIMERA_PARTE, RETAILERS } from './schema-v2.js';
import { sqlReferencia } from './referencia.js';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIAS = Number(argOf('--dias') ?? 7);

const CAIDA_MIN = 0.30;
const CAIDA_MAX = 0.85;
// Ahorro mínimo, igual que en ofertas.js. Antes había aquí un piso de precio de S/100 que la
// selección dejó de usar el 2026-07-28 (se midió que era un filtro con sólo falsos negativos) y
// que esta auditoría siguió aplicando, midiendo por tanto otro conjunto de ofertas.
const AHORRO_MINIMO = 2500;
const DIAS_SOSTENIDO = 3;     // el umbral del algoritmo VIEJO, para poder compararlo
const VUELTA = 0.90;          // se considera que volvió si recupera el 90% de la referencia

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// Candidatos en el corte T, con la referencia según cada algoritmo.
// `dur` se recorta en T: un punto vigente al llegar el corte no puede "durar" más allá de él.
const SQL_CANDIDATOS = `
  WITH corte AS (SELECT strftime('%s','now') - ${DIAS} * 86400 AS t),
  ${sqlReferencia({ ahora: '(SELECT t FROM corte)' })},
  ref_max_sostenido AS ( -- el criterio de antes del 28-jul: máximo entre los precios vigentes >= 3 días
    SELECT product_fk, MAX(price_online) AS ref
    FROM pts WHERE dur >= ${DIAS_SOSTENIDO} * 86400
    GROUP BY product_fk
  ),
  estado_en_t AS ( -- precio y stock vigentes justo en el corte
    SELECT product_fk, price_online, in_stock FROM (
      SELECT product_fk, price_online, in_stock,
             ROW_NUMBER() OVER (PARTITION BY product_fk ORDER BY ts DESC) rk
      FROM pts
    ) WHERE rk = 1
  )
  SELECT e.product_fk, e.price_online AS precio_t,
         MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref)) AS ref_hoy,
         md.ref AS ref_mediana, v.ref AS ref_max
  FROM estado_en_t e
  JOIN products p               ON p.id = e.product_fk
  LEFT JOIN sostenidos s        ON s.product_fk = e.product_fk
  LEFT JOIN mediana md          ON md.product_fk = e.product_fk
  LEFT JOIN ref_max_sostenido v ON v.product_fk = e.product_fk
  WHERE e.in_stock = 1
    AND (p.retailer <> ${RETAILERS.falabella.id}
         OR p.seller = (SELECT id FROM sellers WHERE name = '${FALABELLA_PRIMERA_PARTE}'))
    AND (s.ref IS NOT NULL OR md.ref IS NOT NULL OR v.ref IS NOT NULL)
`;

// Qué hizo el precio DESPUÉS del corte: el máximo alcanzado.
const SQL_DESPUES = `
  WITH corte AS (SELECT strftime('%s','now') - ${DIAS} * 86400 AS t)
  SELECT product_fk, MAX(price_online) AS max_despues
  FROM price_points
  WHERE ts > (SELECT t FROM corte)
  GROUP BY product_fk
`;

log(`[auditoría] corte hace ${DIAS} días; simulando qué se habría publicado entonces…`);
const candidatos = await query(SQL_CANDIDATOS);
const despues = new Map((await query(SQL_DESPUES)).map((r) => [r.product_fk, r.max_despues]));
log(`[auditoría] ${candidatos.length.toLocaleString('es-PE')} productos con precio y stock en el corte`);

function evaluar(nombre, refDe) {
  const publicadas = [];
  for (const c of candidatos) {
    const ref = refDe(c);
    if (ref == null) continue;
    if (ref - c.precio_t < AHORRO_MINIMO) continue;
    const caida = 1 - c.precio_t / ref;
    if (caida < CAIDA_MIN || caida > CAIDA_MAX) continue;
    publicadas.push({ ...c, ref, caida });
  }
  let volvieron = 0, sinDatoPosterior = 0;
  for (const o of publicadas) {
    const mx = despues.get(o.product_fk);
    if (mx == null) { sinDatoPosterior++; continue; }
    if (mx >= o.ref * VUELTA) volvieron++;
  }
  // Sin cambios posteriores = el precio siguió donde estaba, o sea NO volvió.
  const evaluables = publicadas.length;
  const pct = evaluables ? (volvieron / evaluables * 100) : 0;
  console.log(
    `  ${nombre.padEnd(26)} publicadas: ${String(publicadas.length).padStart(5)}` +
    `  ·  volvieron a su referencia: ${String(volvieron).padStart(5)} (${pct.toFixed(1)}%)` +
    `  ·  sin cambios después: ${sinDatoPosterior}`
  );
  return { nombre, publicadas: publicadas.length, volvieron, pct, lista: publicadas };
}

console.log('\n— ¿volvió el precio a su referencia? —');
const nueva = evaluar('mín. previo + mediana (hoy)', (c) => c.ref_hoy);
const vieja = evaluar('mediana sola (hasta 31-jul)', (c) => c.ref_mediana);
const antigua = evaluar('máximo sostenido (hasta 28-jul)', (c) => c.ref_max);

// ---------------------------------------------------------------------------------------------
// SEGUNDA MÉTRICA: ¿CUÁNTO AGUANTÓ LA REFERENCIA?
//
// La primera no discrimina, y hay que decirlo: con 15 días de historial la mayoría de productos
// no cambia de precio en la ventana posterior, así que "¿volvió?" queda sin respuesta para el
// grueso de la muestra y el resultado se lo come el ruido.
//
// Ésta mide directamente el fallo del caso Puma: qué fracción del tiempo observado el producto
// estuvo REALMENTE en su precio de referencia (o por encima). Una referencia legítima es un
// precio que el producto sostuvo; una inventada es un pico de tres días. No hace falta esperar
// a que pase nada después, así que usa toda la historia disponible.
// ---------------------------------------------------------------------------------------------
async function aguante(publicadas, etiqueta) {
  if (!publicadas.length) return;
  const ids = publicadas.map((p) => p.product_fk);
  const filas = await query(`
    WITH corte AS (SELECT strftime('%s','now') - ${DIAS} * 86400 AS t)
    SELECT product_fk, price_online,
           MIN(COALESCE(LEAD(ts) OVER (PARTITION BY product_fk ORDER BY ts),
                        (SELECT t FROM corte)), (SELECT t FROM corte)) - ts AS dur
    FROM price_points
    WHERE ts <= (SELECT t FROM corte) AND product_fk IN (${ids.join(',')})
  `);
  const porProducto = new Map();
  for (const f of filas) {
    if (!porProducto.has(f.product_fk)) porProducto.set(f.product_fk, []);
    porProducto.get(f.product_fk).push(f);
  }
  const fracciones = [];
  for (const p of publicadas) {
    const pts = porProducto.get(p.product_fk) ?? [];
    const total = pts.reduce((a, x) => a + Math.max(0, x.dur), 0);
    if (!total) continue;
    const enRef = pts.reduce((a, x) => a + (x.price_online >= p.ref * 0.9 ? Math.max(0, x.dur) : 0), 0);
    fracciones.push(enRef / total);
  }
  fracciones.sort((a, b) => a - b);
  const media = fracciones.reduce((a, b) => a + b, 0) / fracciones.length;
  const mediana = fracciones[Math.floor(fracciones.length / 2)];
  const frágiles = fracciones.filter((f) => f < 0.5).length;
  console.log(
    `  ${etiqueta.padEnd(26)} tiempo en la referencia → media ${(media * 100).toFixed(0)}%` +
    ` · mediana ${(mediana * 100).toFixed(0)}%` +
    ` · referencias débiles (vigentes <50% del tiempo): ${frágiles} de ${fracciones.length}` +
    ` (${(frágiles / fracciones.length * 100).toFixed(0)}%)`
  );
}

console.log('\n— ¿cuánto tiempo estuvo vigente esa referencia? —');
await aguante(nueva.lista, 'mín. previo + mediana (hoy)');
await aguante(vieja.lista, 'mediana sola (hasta 31-jul)');


// ---------------------------------------------------------------------------------------------
// TERCERA MÉTRICA: ¿DICEN LO MISMO EL CARRUSEL Y EL POP-UP?
//
// Son dos nociones distintas de "precio de referencia" y pueden contradecirse: el carrusel usa la
// menor del mínimo previo y la mediana; el veredicto de la ficha usa el mínimo y el promedio de
// los últimos 90 días (makeVerdict en api/aggregates.js). El 2026-07-31 Pablo abrió un parlante
// anunciado al -72% cuya ficha decía "Precio normal" — y tenía razón la ficha.
//
// Ese día, tras cambiar la referencia, se midió que las 164 ofertas publicadas mostraban
// "Cerca de su mínimo histórico": la contradicción desapareció sola, porque exigir que el precio
// esté por debajo de todo lo anterior lo deja por fuerza cerca del mínimo. Esto lo vigila para
// que no vuelva sin que nadie se entere.
//
// La condición está copiada de makeVerdict (precio <= mínimo de 90 días * 1.02) porque vive en
// otro repo y no se puede importar. Si allí cambia, aquí hay que tocarlo: es la única copia que
// queda y por eso está dicho aquí.
const coherencia = await query(`
  WITH m AS (
    SELECT product_fk, MIN(price_online) AS minimo
    FROM price_points
    WHERE ts >= strftime('%s','now') - 90 * 86400
    GROUP BY product_fk
  )
  SELECT p.name, o.ref, o.precio, m.minimo
  FROM ofertas o
  JOIN m ON m.product_fk = o.product_fk
  JOIN products p ON p.id = o.product_fk
  WHERE o.precio > m.minimo * 1.02
`);
const publicadas = await query('SELECT COUNT(*) n FROM ofertas');
console.log('\n— ¿el pop-up contradice al carrusel? —');
if (!coherencia.length) {
  console.log(`  ninguna de las ${publicadas[0].n} publicadas: todas saldrían como "cerca de su mínimo histórico"`);
} else {
  console.log(`  ${coherencia.length} de ${publicadas[0].n} publicadas NO saldrían como "cerca de su mínimo" en su ficha:`);
  for (const c of coherencia.slice(0, 10)) {
    console.log(`     S/${(c.ref / 100).toFixed(2)} → S/${(c.precio / 100).toFixed(2)}` +
                ` pero su mínimo de 90 días es S/${(c.minimo / 100).toFixed(2)}  ${String(c.name).slice(0, 46)}`);
  }
}

console.log('');
log(`[auditoría] la primera métrica no discrimina con ${DIAS} días de ventana posterior: la mayoría`);
log(`[auditoría] de productos no cambia de precio en ese plazo. La segunda sí, y no necesita esperar.`);
