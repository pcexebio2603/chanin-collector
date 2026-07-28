// Caza Precio: detecta caídas de precio creíbles y las deja precalculadas en la tabla `ofertas`.
// Corre una vez por corrida del colector (paso final del workflow); el Worker sólo LEE esa tabla,
// así que servir el carrusel cuesta una consulta trivial en vez de escanear 900k price_points.
//
// Uso: CLOUDFLARE_API_TOKEN=... node ofertas.js [--ver]
//   --ver: imprime el top 15 en vez de limitarse a resumir.
//
// ---------------------------------------------------------------------------------------------
// EL FILTRO DE CREDIBILIDAD, Y POR QUÉ TIENE DOS PARTES
//
// `04-monetizacion.md` §8 daba por hecho que una sola regla separaba oferta real de fantasma:
// que el precio pre-caída hubiera vivido varios días en nuestro historial. **Medido contra los
// datos reales el 2026-07-27, esa regla NO basta**: los placeholders de catálogo (S/9,899 en
// Promart/Oechsle, S/99,999 en TVs, S/9,000 en el teclado 8BitDo) permanecen semanas cargados
// antes de corregirse, así que la superan sin problema. Con sólo esa regla, los 18 primeros
// resultados del carrusel eran basura.
//
// El segundo discriminante sale de mirar qué tienen en común: un mismo valor de referencia
// aparece en MUCHOS productos distintos y siempre produce caídas absurdas. Un precio real es
// propio del producto; un centinela es una constante del catálogo. Ojo: no basta con que el
// valor se repita — S/299 lo comparten 11 productos y es un precio legítimo. Lo que delata al
// centinela es repetirse Y que la caída media que produce sea desproporcionada.
//
// La banda se corta en 85%: por encima, todo lo inspeccionado era fantasma. Ahí es donde viviría
// la categoría "posible error de precio" de §8 (el caso Makita S/799→39), pero necesita más
// evidencia que la que hoy da un historial de dos semanas — publicar un 96% inventado sería
// justo lo contrario de la promesa de marca. Queda para una v2.
// ---------------------------------------------------------------------------------------------
import { query, exec } from './d1-client.js';

const VER = process.argv.includes('--ver');

const DIAS_SOSTENIDO = 3;     // el precio de referencia tuvo que estar vigente al menos esto
const CAIDA_MIN = 0.30;
const CAIDA_MAX = 0.85;       // por encima domina el fantasma; ver cabecera
const PISO_CENTIMOS = 10000;  // S/100: por debajo el ruido se come la señal
const CENTINELA_PRODUCTOS = 3;    // un valor de referencia compartido por al menos tantos productos…
const CENTINELA_CAIDA = 0.88;     // …y con caída media de este orden, es un placeholder de catálogo

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// Duración real de cada punto: como sólo guardamos cambios, un punto rige hasta el siguiente.
const SELECCION = `
  WITH pts AS (
    SELECT product_fk, ts, price_online,
           LEAD(ts) OVER (PARTITION BY product_fk ORDER BY ts) AS ts_sig
    FROM price_points
  ),
  sostenidos AS (
    SELECT product_fk, MAX(price_online) AS ref
    FROM pts
    WHERE (COALESCE(ts_sig, strftime('%s','now')) - ts) >= ${DIAS_SOSTENIDO} * 86400
    GROUP BY product_fk
  ),
  cand AS (
    SELECT p.id, s.ref, p.cur_online, (1 - p.cur_online * 1.0 / s.ref) AS caida
    FROM products p
    JOIN sostenidos s ON s.product_fk = p.id
    WHERE p.cur_stock = 1                    -- sin stock no es oferta: nadie puede comprarla
      AND p.cur_online IS NOT NULL
      AND p.cur_online >= ${PISO_CENTIMOS}
      AND p.cur_online < s.ref * (1 - ${CAIDA_MIN})
  ),
  centinelas AS (
    SELECT ref FROM cand
    GROUP BY ref
    HAVING COUNT(*) >= ${CENTINELA_PRODUCTOS} AND AVG(caida) >= ${CENTINELA_CAIDA}
  )
  SELECT id, ref, cur_online, caida FROM cand
  WHERE caida <= ${CAIDA_MAX} AND ref NOT IN (SELECT ref FROM centinelas)
`;

await exec(`
  CREATE TABLE IF NOT EXISTS ofertas (
    product_fk INTEGER PRIMARY KEY,
    ref        INTEGER NOT NULL,
    precio     INTEGER NOT NULL,
    caida      REAL NOT NULL,
    calculado  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ofertas_caida ON ofertas(caida DESC);
`);

// Recalculado entero en cada corrida: la vida útil de una oferta es de 1-3 días (verificado en
// el análisis del 2026-07-24), así que arrastrar las viejas mostraría precios que ya no existen.
const ahora = Math.floor(Date.now() / 1000);
await exec(`
  DELETE FROM ofertas;
  INSERT INTO ofertas (product_fk, ref, precio, caida, calculado)
  SELECT id, ref, cur_online, caida, ${ahora} FROM (${SELECCION});
`);

const [{ n, prof }] = await query(
  `SELECT COUNT(*) n, SUM(caida >= 0.5) prof FROM ofertas`
);
log(`[ofertas] ${n} ofertas creíbles (${prof ?? 0} con caída >=50%)`);

if (VER) {
  const top = await query(`
    SELECT rt.name tienda, SUBSTR(p.name, 1, 44) producto,
           o.ref/100.0 antes, o.precio/100.0 ahora, ROUND(o.caida*100) pct
    FROM ofertas o
    JOIN products p ON p.id = o.product_fk
    JOIN retailers rt ON rt.id = p.retailer
    ORDER BY o.caida DESC LIMIT 15
  `);
  for (const o of top) {
    console.log(`  ${String(o.pct).padStart(3)}%  ${o.antes} → ${o.ahora}  ${o.tienda.padEnd(10)} ${o.producto}`);
  }
}
