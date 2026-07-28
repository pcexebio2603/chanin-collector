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
// POR QUÉ LA REFERENCIA YA NO ES EL MÁXIMO (2026-07-28)
//
// Usar el máximo sostenido premiaba exactamente la manipulación que este producto denuncia:
// subir el precio unos días para poder anunciar después un descuento enorme. Caso real que lo
// destapó — zapatillas Puma Court Lally de Falabella (sku 21386335):
//
//     14-jul  S/129   6.1 días   45% del tiempo
//     20-jul  S/616   3.5 días   26%     ← pico; superaba el umbral de "sostenido"
//     24-jul  S/169   4.0 días   29%     ← precio actual
//
// El carrusel las anunciaba como "de S/616 a S/169", un 73% de descuento inventado: su precio
// habitual ronda los S/129-169. El máximo es justo el estadístico más frágil ante un pico.
//
// La referencia es ahora la MEDIANA PONDERADA POR TIEMPO: el precio por debajo del cual el
// producto pasó la mitad de su vida. Para las Puma da S/169 — su precio actual — así que la
// caída es 0% y desaparecen. Un pico corto ya no puede fijar la referencia por sí solo.
//
// Efecto secundario deseable: si un precio rebajado se sostiene más tiempo que el anterior,
// pasa a ser la referencia y el producto deja de anunciarse como oferta. Es correcto: a esas
// alturas ya no es una rebaja, es su precio nuevo.
//
// La banda se corta en 85%: por encima, todo lo inspeccionado era fantasma. Ahí es donde viviría
// la categoría "posible error de precio" de §8 (el caso Makita S/799→39), pero necesita más
// evidencia que la que hoy da un historial de dos semanas — publicar un 96% inventado sería
// justo lo contrario de la promesa de marca. Queda para una v2.
// ---------------------------------------------------------------------------------------------
import { query, exec } from './d1-client.js';
import { BY_ID, RETAILERS, decodeUrl, FALABELLA_PRIMERA_PARTE } from './schema-v2.js';
import { revisar, registrar, resumen } from './guardian.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VER = process.argv.includes('--ver');

const DIAS_VENTANA = 90;      // historia que entra en la mediana; hoy sobra, en octubre no
const CAIDA_MIN = 0.30;
const CAIDA_MAX = 0.85;       // por encima domina el fantasma; ver cabecera
const PISO_CENTIMOS = 10000;  // S/100: por debajo el ruido se come la señal
const CENTINELA_PRODUCTOS = 3;    // un valor de referencia compartido por al menos tantos productos…
const CENTINELA_CAIDA = 0.88;     // …y con caída media de este orden, es un placeholder de catálogo

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// Duración real de cada punto: como sólo guardamos cambios, un punto rige hasta el siguiente.
// La mediana ponderada = el precio más bajo cuya duración acumulada (ordenando de menor a mayor)
// alcanza la mitad del tiempo total observado.
const SELECCION = `
  WITH pts AS (
    SELECT product_fk, price_online,
           COALESCE(LEAD(ts) OVER (PARTITION BY product_fk ORDER BY ts), strftime('%s','now')) - ts AS dur
    FROM price_points
    WHERE ts >= strftime('%s','now') - ${DIAS_VENTANA} * 86400
  ),
  acum AS (
    SELECT product_fk, price_online,
           SUM(dur) OVER (PARTITION BY product_fk ORDER BY price_online
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS hasta_aqui,
           SUM(dur) OVER (PARTITION BY product_fk) AS total
    FROM pts
  ),
  sostenidos AS (
    SELECT product_fk, MIN(price_online) AS ref
    FROM acum
    WHERE total > 0 AND hasta_aqui >= total / 2.0
    GROUP BY product_fk
  ),
  -- La referencia final es la MENOR entre la que medimos y el precio normal que declara la
  -- propia tienda. Nunca se sube para igualar un "antes" inflado; sólo se baja cuando la tienda
  -- admite que su precio habitual es menor que lo que nosotros vimos.
  --
  -- Lo destapó Pablo con un procesador AMD Ryzen 5 3600 (2026-07-28): lo anunciábamos "de
  -- S/1,012 a S/508", y era cierto que costó 1,012 durante 13 de los 15 días que llevábamos
  -- midiendo. Pero la tienda declaraba un precio de lista de S/564: el 1,012 era un precio
  -- viejo que dejaron de sostener, no la referencia del producto. El descuento real era del
  -- 10%, no del 50%. Ninguna tienda declara un "antes" MÁS BARATO de lo que cobró de verdad,
  -- así que cuando su lista queda por debajo de nuestra medición, manda la suya.
  --
  -- Afectaba a 247 de 484 ofertas: su caída media pasa del 36% al 21%.
  cand AS (
    SELECT p.id,
           MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref)) AS ref,
           p.cur_online,
           (1 - p.cur_online * 1.0 / MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref))) AS caida
    FROM products p
    JOIN sostenidos s ON s.product_fk = p.id
    WHERE p.cur_stock = 1                    -- sin stock no es oferta: nadie puede comprarla
      AND p.cur_online IS NOT NULL
      AND p.cur_online >= ${PISO_CENTIMOS}
      AND p.cur_online < MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref)) * (1 - ${CAIDA_MIN})
      -- Sólo precios que fija la propia tienda. En Falabella se EXIGE primera parte; no vale
      -- con "seller IS NULL", porque 385k productos suyos llevan corridas sin volver a verse y
      -- también tienen el vendedor a nulo: colarían como si fueran de Falabella. Los retailers
      -- VTEX no tienen el concepto de vendedor y pasan sin más.
      -- De aquí salen dos de los tres patrones de descuento fantasma de 04 §8 (lista inflada de
      -- marketplace y ancla fija de seller); el tercero, el placeholder de S/9,899, es de
      -- Promart y Oechsle, así que este filtro NO lo toca.
      AND (p.retailer <> ${RETAILERS.falabella.id}
           OR p.seller = (SELECT id FROM sellers WHERE name = '${FALABELLA_PRIMERA_PARTE}'))
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

// Candidatas, con lo justo para reconstruir su url y poder comprobarla.
const cands = await query(`
  SELECT c.id, c.ref, c.cur_online, c.caida, p.retailer, p.sku, p.product_id, p.slug
  FROM (${SELECCION}) c JOIN products p ON p.id = c.id
`);
log(`[ofertas] ${cands.length} candidatas tras el filtro de credibilidad`);

// ---------------------------------------------------------------------------------------------
// VERIFICACIÓN CONTRA LA TIENDA, ANTES DE PUBLICAR
//
// El estado que guardamos es el del último día que VIMOS el producto, y un producto que
// desaparece del listado se queda fosilizado ahí para siempre. Caso real (2026-07-28): el
// BookCover Samsung de Plaza Vea salía en el carrusel a S/249 con stock cuando la tienda ya lo
// daba AGOTADO a S/499. La comprobación de url no lo pilla: la ficha existe y responde 200.
//
// Medido sobre las ofertas publicadas ese día: 3 de 75 VTEX (4%) estaban agotadas. Poco, pero
// inaceptable cuando toda la promesa de la página es no mentir — y le tocó al primer producto
// que abrió Pablo.
//
// Para VTEX se consulta la API de catálogo, que da precio y disponibilidad reales y admite
// varios SKUs por llamada (verificado): las ~450 ofertas se comprueban en una docena de
// peticiones. Si el precio ya no coincide, tampoco se publica: significa que nuestro dato está
// viejo, y la próxima corrida lo recogerá bien.
// ---------------------------------------------------------------------------------------------
const HOST_VTEX = {
  oechsle: 'https://www.oechsle.pe',
  plazavea: 'https://www.plazavea.com.pe',
  promart: 'https://www.promart.pe',
};
const POR_LOTE = 40;

async function verificarVtex(lista) {
  const buenos = new Set();
  const porTienda = new Map();
  for (const c of lista) {
    const t = BY_ID[c.retailer].name;
    if (!HOST_VTEX[t]) continue;
    if (!porTienda.has(t)) porTienda.set(t, []);
    porTienda.get(t).push(c);
  }
  for (const [tienda, cands] of porTienda) {
    for (let i = 0; i < cands.length; i += POR_LOTE) {
      const lote = cands.slice(i, i + POR_LOTE);
      const fq = lote.map((c) => `fq=skuId:${encodeURIComponent(c.sku)}`).join('&');
      try {
        const res = await fetch(`${HOST_VTEX[tienda]}/api/catalog_system/pub/products/search?${fq}&_from=0&_to=49`, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(25000),
        });
        const prods = await res.json();
        const vivos = new Map();
        for (const p of prods ?? []) {
          for (const it of p.items ?? []) {
            const of = it.sellers?.[0]?.commertialOffer;
            if (of) vivos.set(String(it.itemId), of);
          }
        }
        for (const c of lote) {
          const of = vivos.get(String(c.sku));
          if (!of || !of.IsAvailable || !(of.AvailableQuantity > 0)) continue;
          if (Math.abs(Math.round(of.Price * 100) - c.cur_online) > 50) continue; // nuestro precio ya no vale
          buenos.add(c.id);
        }
      } catch {
        for (const c of lote) buenos.add(c.id); // fallo de red: no castigamos, se revisa mañana
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return buenos;
}

// ---------------------------------------------------------------------------------------------
// PRODUCTOS MUERTOS
// Un producto puede seguir en nuestra base con precio y stock y aun así llevar a un 404: la
// tienda lo descatalogó o le cambió el slug (caso real: la Torre de Sonido Samsung de Oechsle
// acababa en /Sistema/404?ProductLinkNotFound=...). Publicar eso quema la confianza de un
// visitante en su primer clic.
//
// `last_checked` NO sirve para detectarlo: sólo se actualiza cuando el precio CAMBIA, así que
// hoy apenas 19k de 794k productos lo tienen fresco (comprobado el 2026-07-28).
//
// Por eso se comprueban las urls por HTTP, pero SÓLO las candidatas (~1k), no el catálogo
// entero: es la diferencia entre un minuto y un día de peticiones. Rate limit respetuoso y
// concurrencia baja, en la línea del resto del colector.
// ---------------------------------------------------------------------------------------------
const MUERTA = /\/Sistema\/404|ProductLinkNotFound|pagina-no-encontrada|not-?found/i;
const CONCURRENCIA = 5;

async function viva(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 400) return false;
    return !MUERTA.test(res.url); // la tienda puede responder 200 tras redirigir a su página de 404
  } catch {
    return true; // ante un fallo de red no castigamos al producto: se revisa en la próxima corrida
  }
}

// VTEX se verifica contra su API de catálogo (precio y stock reales, y de paso descarta lo
// descatalogado). Falabella no tiene endpoint por SKU, así que se queda con la comprobación de
// url — pilla los 404 pero no un "agotado", que es una limitación conocida y anotada.
const okVtex = await verificarVtex(cands);
const esFala = (c) => BY_ID[c.retailer].name === 'falabella';
const vtex = cands.filter((c) => !esFala(c));
const fala = cands.filter(esFala);

const vivas = vtex.filter((c) => okVtex.has(c.id));
log(`[ofertas] VTEX: ${vivas.length} de ${vtex.length} siguen con el mismo precio y con stock`);

let muertas = 0;
for (let i = 0; i < fala.length; i += CONCURRENCIA) {
  const trozo = fala.slice(i, i + CONCURRENCIA);
  const res = await Promise.all(trozo.map((c) => {
    const r = BY_ID[c.retailer];
    return viva(decodeUrl(r, c.product_id, c.slug));
  }));
  res.forEach((ok, j) => (ok ? vivas.push(trozo[j]) : muertas++));
  await new Promise((r) => setTimeout(r, 250));
}
log(`[ofertas] Falabella: ${muertas} descartadas por llevar a una página muerta`);

// El guardián revisa lo que ha sobrevivido y aparta lo que se contradice consigo mismo.
const { limpias, motivos, canarios } = await revisar(vivas);
if (motivos.size) {
  await registrar(motivos, new Map(vivas.map((c) => [c.id, c])));
  log(`[ofertas] ${motivos.size} apartadas por el guardián:`);
  for (const [motivo, n] of resumen(motivos)) console.log(`             ${String(n).padStart(4)}  ${motivo}`);
} else {
  log('[ofertas] el guardián no apartó ninguna');
}

// Recalculado entero en cada corrida: la vida útil de una oferta es de 1-3 días (verificado en
// el análisis del 2026-07-24), así que arrastrar las viejas mostraría precios que ya no existen.
const ahora = Math.floor(Date.now() / 1000);
await exec('DELETE FROM ofertas;');
for (let i = 0; i < limpias.length; i += 25) {
  const trozo = limpias.slice(i, i + 25);
  await exec(trozo.map((c) =>
    `INSERT INTO ofertas (product_fk, ref, precio, caida, calculado) ` +
    `VALUES (${c.id},${c.ref},${c.cur_online},${c.caida},${ahora})`
  ).join(';\n') + ';');
}

const [{ n, prof }] = await query(
  `SELECT COUNT(*) n, SUM(caida >= 0.5) prof FROM ofertas`
);
log(`[ofertas] ${n} ofertas publicables (${prof ?? 0} con caída >=50%)`);

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

// Un canario que reaparece significa que un cambio en el detector revivió un fallo ya corregido.
// Se falla la corrida A PROPÓSITO —las ofertas limpias ya están publicadas— para que GitHub avise.
if (canarios.length) {
  console.error('\n*** REGRESIÓN: han reaparecido casos que ya estaban corregidos ***');
  for (const c of canarios) console.error(`    · ${c.que}`);
  process.exit(1);
}
