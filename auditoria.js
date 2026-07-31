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
import { FALABELLA_PRIMERA_PARTE, RETAILERS, BY_ID } from './schema-v2.js';
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
// TERCERA MÉTRICA: ¿DICEN LO MISMO EL CARRUSEL Y LA FICHA?
//
// Son dos nociones distintas de "precio de referencia" y pueden contradecirse: el carrusel usa la
// menor del mínimo previo y la mediana; el veredicto de la ficha usa el mínimo y el promedio de
// los últimos 90 días. El 2026-07-31 Pablo abrió un parlante anunciado al -72% cuya ficha decía
// "Precio normal" — y tenía razón la ficha.
//
// Ese día, tras cambiar la referencia, se midió que las 164 ofertas publicadas mostraban "Cerca
// de su mínimo histórico": la contradicción desapareció sola, porque exigir que el precio esté
// por debajo de todo lo anterior lo deja por fuerza cerca del mínimo. Esto vigila que no vuelva.
//
// SE LE PREGUNTA A LA API EN VIVO, no se reimplementa su condición. La primera versión copiaba
// aquí el "precio <= mínimo de 90 días * 1.02" de makeVerdict, que vive en el repo del Worker y
// no se puede importar — o sea, una copia más de las que hoy costaron dos herramientas mintiendo.
// Preguntando se prueba además la cadena entera (Worker incluido) en vez de mi versión de ella.
const API = process.env.CHANIN_API ?? 'https://chanin-api.pablocarrascoe26.workers.dev';
const publicadas = await query(`
  SELECT p.retailer, p.sku, p.name, o.ref, o.precio
  FROM ofertas o JOIN products p ON p.id = o.product_fk
`);
console.log('\n— ¿la ficha contradice al carrusel? —');
if (!publicadas.length) {
  console.log('  la tabla `ofertas` está vacía: nada que comprobar');
} else {
  const discrepantes = [];
  let sinRespuesta = 0;
  for (let i = 0; i < publicadas.length; i += 20) {
    const trozo = publicadas.slice(i, i + 20);
    const veredictos = await Promise.all(trozo.map(async (o) => {
      const r = BY_ID[o.retailer].name;
      try {
        const res = await fetch(`${API}/history?retailer=${r}&sku=${encodeURIComponent(o.sku)}`);
        const j = await res.json();
        return j?.verdict?.code ?? null;
      } catch { return null; }
    }));
    veredictos.forEach((code, j) => {
      if (code == null) sinRespuesta++;
      else if (code !== 'near_low') discrepantes.push({ ...trozo[j], code });
    });
  }
  const evaluadas = publicadas.length - sinRespuesta;
  if (!discrepantes.length) {
    console.log(`  ninguna de las ${evaluadas} publicadas: todas salen como "cerca de su mínimo histórico" en su ficha`);
  } else {
    console.log(`  ${discrepantes.length} de ${evaluadas} publicadas NO salen como "cerca de su mínimo" en su ficha:`);
    for (const d of discrepantes.slice(0, 10)) {
      console.log(`     carrusel S/${(d.ref / 100).toFixed(2)} → S/${(d.precio / 100).toFixed(2)}` +
                  ` · ficha "${d.code}"  ${String(d.name).slice(0, 46)}`);
    }
  }
  if (sinRespuesta) console.log(`  (${sinRespuesta} sin respuesta de la API; no cuentan ni a favor ni en contra)`);
}

// ---------------------------------------------------------------------------------------------
// CUARTA: ROTACIÓN DEL CARRUSEL, corrida a corrida.
// La tabla `ofertas` se reescribe entera, así que sin este resumen la pregunta "¿se está quedando
// corto?, ¿entra y sale demasiado?" sólo se responde mirándolo a mano y acordándose de hacerlo.
const rot = await query(`
  SELECT calculado, publicadas, nuevas, salidas
  FROM ofertas_resumen ORDER BY calculado DESC LIMIT 14
`).catch(() => []);
console.log('\n— rotación del carrusel —');
if (!rot.length) {
  console.log('  todavía no hay resumen: lo empieza a escribir ofertas.js desde el 2026-07-31');
} else {
  for (const r of rot.reverse()) {
    console.log(`  ${new Date(r.calculado * 1000).toISOString().slice(0, 16).replace('T', ' ')}` +
                `  ${String(r.publicadas).padStart(4)} publicadas  (+${r.nuevas} / -${r.salidas})`);
  }
}

// ---------------------------------------------------------------------------------------------
// QUINTA: ¿IMPORTA YA LA VENTANA DE 90 DÍAS?
// Mientras ninguna oferta publicada se apoye en datos más viejos que la ventana más corta que
// consideraríamos, las de 30, 60 y 90 días dan lo mismo y no hay nada que decidir. Correr la
// selección tres veces para comprobarlo costaría 90M de filas leídas cada semana; basta con mirar
// la edad del punto más antiguo que entra en juego. El día que se acerque a 30, la decisión
// aparece aquí sola en vez de por sorpresa.
const edad = await query(`
  SELECT MAX(dias) AS mas_viejo, AVG(dias) AS media FROM (
    SELECT (strftime('%s','now') - MIN(pp.ts)) / 86400.0 AS dias
    FROM ofertas o JOIN price_points pp ON pp.product_fk = o.product_fk
    GROUP BY o.product_fk)
`);
const mv = edad[0]?.mas_viejo ?? 0;
console.log('\n— ¿importa ya la ventana de 90 días? —');
console.log(`  el punto más antiguo que usa una oferta publicada tiene ${mv.toFixed(1)} días` +
            ` (media ${(edad[0]?.media ?? 0).toFixed(1)})`);
console.log(mv < 30
  ? '  por debajo de 30: las ventanas de 30, 60 y 90 días dan exactamente lo mismo. No hay nada que decidir.'
  : '  YA PASA DE 30 DÍAS: toca decidir si un precio de hace meses sigue siendo "el precio de antes".');

console.log('');
log(`[auditoría] la primera métrica no discrimina con ${DIAS} días de ventana posterior: la mayoría`);
log(`[auditoría] de productos no cambia de precio en ese plazo. La segunda sí, y no necesita esperar.`);
