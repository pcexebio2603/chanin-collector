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
// La referencia pasó a ser la MEDIANA PONDERADA POR TIEMPO: el precio por debajo del cual el
// producto pasó la mitad de su vida. Para las Puma da S/169 — su precio actual — así que la
// caída es 0% y desaparecen. Un pico corto ya no puede fijar la referencia por sí solo.
//
// (SUPERADO el 2026-07-31: la mediana aguanta el pico corto pero no el largo, y el que manipula
// elige cuánto dura. Hoy la referencia es la MENOR del mínimo previo y esta mediana; el
// razonamiento y el caso que lo forzó están en referencia.js, que es de donde sale el SQL.)
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
import { sqlReferencia } from './referencia.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VER = process.argv.includes('--ver');
// --reverificar: NO recalcula candidatas. Coge lo ya publicado y sólo comprueba que siga vivo,
// para que el carrusel no arrastre medio día una oferta agotada. La verificación de la corrida
// completa es una foto del momento; esto la refresca sin repetir el trabajo caro.
const REVERIFICAR = process.argv.includes('--reverificar');
// --rechazadas: no publica nada. Lista los productos que SE QUEDARON FUERA del carrusel y por
// qué, con su historial de precios al lado. Existe para poder auditar el criterio sin leer el
// SQL: si algún día vuelve a colarse una oferta fantasma, el primer sitio donde mirar es qué
// dice esta lista de sus vecinas. Sale el motivo exacto de cada descarte, no un "no cumple".
const RECHAZADAS = process.argv.includes('--rechazadas');

const CAIDA_MIN = 0.30;
const CAIDA_MAX = 0.85;       // por encima domina el fantasma; ver cabecera
// Ahorro mínimo para ocupar un hueco del carrusel. Sustituye al antiguo piso de precio de
// S/100 el 2026-07-28, después de medirlo: el piso se justificaba diciendo que "por debajo el
// ruido se come la señal", y eso resultó ser FALSO. Por bandas de precio, la caída media (35-39%),
// la profundidad del historial y la solidez de la referencia (66-70% del tiempo, cero referencias
// débiles) salen iguales arriba y abajo. Las ofertas baratas están igual de bien fundadas.
//
// Lo único que cambiaba de verdad era el ahorro absoluto: S/387 de media por encima de S/100,
// S/13 por debajo de S/30. O sea que el filtro que queríamos era sobre el AHORRO, no sobre el
// precio. Y el piso no protegía de nada: ni una sola oferta de las que pasaban ahorraba menos de
// S/25, mientras bloqueaba 267 que sí lo superaban. Era un filtro con sólo falsos negativos.
//
// Lo que entra con este cambio es en un 92% moda de Falabella — justo donde su catálogo propio
// es fuerte, al contrario que en tecnología (90% marketplace).
const AHORRO_MINIMO = 2500;   // S/25
const CENTINELA_PRODUCTOS = 3;    // un valor de referencia compartido por al menos tantos productos…
const CENTINELA_CAIDA = 0.88;     // …y con caída media de este orden, es un placeholder de catálogo

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// La referencia —el "antes" de cada oferta— se calcula en referencia.js, que la comparten esta
// selección, el diagnóstico de porque-no.js y la auditoría semanal. Allí está el razonamiento
// completo: por qué es la MENOR del mínimo previo y la mediana ponderada, y qué caso lo forzó.
const SELECCION = `
  WITH ${sqlReferencia()},
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
      AND MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref)) - p.cur_online >= ${AHORRO_MINIMO}
      AND p.cur_online < MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref)) * (1 - ${CAIDA_MIN})
      -- Sólo precios que fija la propia tienda. En Falabella, un vendedor nulo NO significa
      -- "es de Falabella": son 385k productos que llevan corridas sin volver a verse (los topes
      -- de página dejan fuera la cola larga de cada categoría). Antes se les cerraba la puerta
      -- aquí, y eso dejaba fuera producto de primera parte legítimo — Pablo trajo varios casos.
      -- Ahora pasan como DESCONOCIDOS y su vendedor se resuelve leyendo la ficha, que de todas
      -- formas ya descargamos para verificar stock. Los retailers VTEX pasan sin más.
      -- De aquí salen dos de los tres patrones de descuento fantasma de 04 §8 (lista inflada de
      -- marketplace y ancla fija de seller); el tercero, el placeholder de S/9,899, es de
      -- Promart y Oechsle, así que este filtro NO lo toca.
      AND (p.retailer <> ${RETAILERS.falabella.id}
           OR p.seller IS NULL
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

// ---------------------------------------------------------------------------------------------
// AUDITORÍA (--rechazadas): por qué NO sale cada producto que tenía referencia.
// No publica nada ni escribe en la base. El orden de los motivos es el mismo que el de la
// selección, así que cada producto aparece con la PRIMERA razón que lo deja fuera.
// ---------------------------------------------------------------------------------------------
if (RECHAZADAS) {
  const filas = await query(`
    WITH ${sqlReferencia()},
    -- 'base' es un nombre que ya usa referencia.js: aquí sería una CTE duplicada y SQLite lo
    -- rechaza. Se llama evaluables.
    evaluables AS (
      SELECT p.id, p.name, p.cur_online, p.cur_stock, p.retailer, p.seller,
             MIN(s.ref, COALESCE(NULLIF(p.cur_list, 0), s.ref)) AS ref
      FROM products p JOIN sostenidos s ON s.product_fk = p.id
      WHERE p.cur_online IS NOT NULL
    ),
    con_caida AS (
      SELECT *, (1 - cur_online * 1.0 / ref) AS caida FROM evaluables WHERE ref > 0
    ),
    -- Los centinelas se calculan sobre EXACTAMENTE la misma población que en la selección (cand):
    -- con stock, con ahorro y caída suficientes Y de primera parte. Sin el filtro de vendedor la
    -- lista salía distinta y la auditoría llamaba "publicables" a 381 productos cuando la
    -- selección dejaba 316 — un diagnóstico que contradice a lo que publica no sirve de nada.
    centinelas AS (
      SELECT ref FROM con_caida
      WHERE cur_stock = 1 AND ref - cur_online >= ${AHORRO_MINIMO} AND caida >= ${CAIDA_MIN}
        AND (retailer <> ${RETAILERS.falabella.id}
             OR seller IS NULL
             OR seller = (SELECT id FROM sellers WHERE name = '${FALABELLA_PRIMERA_PARTE}'))
      GROUP BY ref
      HAVING COUNT(*) >= ${CENTINELA_PRODUCTOS} AND AVG(caida) >= ${CENTINELA_CAIDA}
    )
    SELECT name, ref, cur_online, caida,
      CASE
        WHEN cur_stock <> 1 THEN 'sin stock'
        WHEN retailer = ${RETAILERS.falabella.id} AND seller IS NOT NULL
             AND seller <> (SELECT id FROM sellers WHERE name = '${FALABELLA_PRIMERA_PARTE}')
             THEN 'vendedor de terceros'
        WHEN caida <= 0 THEN 'hoy no esta por debajo de su minimo previo'
        WHEN ref - cur_online < ${AHORRO_MINIMO} THEN 'ahorro menor a S/${AHORRO_MINIMO / 100}'
        -- La misma desigualdad que usa cand, copiada tal cual y no reescrita como caida < X: la
        -- selección exige ESTRICTAMENTE por debajo del 70%, y con precios redondos el 30% clavado
        -- es frecuente. Escribirla de otra forma hacía que la auditoría llamara publicables a 65
        -- productos que la selección rechazaba (medido el 31-jul).
        WHEN cur_online >= ref * (1 - ${CAIDA_MIN}) THEN 'caida del ${CAIDA_MIN * 100}% o menos'
        WHEN caida > ${CAIDA_MAX} THEN 'caida mayor al ${CAIDA_MAX * 100}% (dominan los fantasmas)'
        WHEN ref IN (SELECT ref FROM centinelas) THEN 'referencia centinela del catalogo'
        ELSE 'publicada'
      END AS motivo
    FROM con_caida
  `);
  const fuera = filas.filter((f) => f.motivo !== 'publicada');
  const cuenta = new Map();
  for (const f of fuera) cuenta.set(f.motivo, (cuenta.get(f.motivo) ?? 0) + 1);
  log(`[auditoría] ${filas.length} productos con referencia previa · ${filas.length - fuera.length} publicables · ${fuera.length} descartados`);
  for (const [motivo, n] of [...cuenta].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(6)}  ${motivo}`);
    for (const f of fuera.filter((x) => x.motivo === motivo).slice(0, VER ? 10 : 3)) {
      console.log(`           S/${(f.ref / 100).toFixed(2)} → S/${(f.cur_online / 100).toFixed(2)}` +
                  ` (${(f.caida * 100).toFixed(0)}%)  ${String(f.name).slice(0, 60)}`);
    }
  }
  process.exit(0);
}

await exec(`
  CREATE TABLE IF NOT EXISTS ofertas (
    product_fk INTEGER PRIMARY KEY,
    ref        INTEGER NOT NULL,
    precio     INTEGER NOT NULL,
    caida      REAL NOT NULL,
    calculado  INTEGER NOT NULL,
    bajo       INTEGER          -- cuándo se produjo la última BAJADA de precio
  );
  CREATE INDEX IF NOT EXISTS idx_ofertas_caida ON ofertas(caida DESC);
`);

// Candidatas, con lo justo para reconstruir su url y poder comprobarla.
// `bajo` = cuándo se produjo la última bajada REAL de precio. No vale con el último cambio a
// secas: un producto que subió un poco pero sigue por debajo de su referencia diría "bajó hace
// X" siendo falso. Se compara cada punto con el anterior y se busca el último descenso.
const cands = REVERIFICAR ? [] : await query(`
  WITH cand AS (${SELECCION}),
  trans AS (
    SELECT product_fk, ts, price_online,
           LAG(price_online) OVER (PARTITION BY product_fk ORDER BY ts) AS ant
    FROM price_points
  ),
  bajada AS (
    SELECT product_fk, MAX(ts) AS bajo FROM trans
    WHERE ant IS NOT NULL AND price_online < ant GROUP BY product_fk
  )
  SELECT c.id, c.ref, c.cur_online, c.caida, p.retailer, p.sku, p.product_id, p.slug, p.seller, b.bajo
  FROM cand c
  JOIN products p       ON p.id = c.id
  LEFT JOIN bajada b    ON b.product_fk = c.id
`);
if (!REVERIFICAR) log(`[ofertas] ${cands.length} candidatas tras el filtro de credibilidad`);

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
// Por eso se comprueban las urls por HTTP, pero SÓLO las candidatas, no el catálogo entero: es
// la diferencia entre un minuto y un día de peticiones. Rate limit respetuoso y concurrencia
// baja, en la línea del resto del colector.
// ---------------------------------------------------------------------------------------------
const MUERTA = /\/Sistema\/404|ProductLinkNotFound|pagina-no-encontrada|not-?found/i;
const CONCURRENCIA = 5;

// Falabella no tiene endpoint por SKU, pero su ficha es Next.js y lleva un `__NEXT_DATA__` con
// todo lo que hace falta. Como la página ya se descargaba para comprobar el 404, leerla en vez
// de tirarla no cuesta NI UNA petición más.
//
// Señales verificadas contra un producto disponible y otro agotado (2026-07-28):
//        isOutOfStock  isPurchaseable  isOnlineSellable
//   ok        false         true            true
//   agotado   true          false           false
// Se usa `isPurchaseable` de la VARIANTE porque va por SKU: un producto puede tener una talla
// agotada y otras disponibles.
//
// Si el marcado cambia y no se puede parsear, se vuelve al comportamiento anterior (sólo mirar
// que no sea un 404) y se registra. Un cambio de maquetación no puede vaciar el carrusel.
let falaSinParsear = 0;
let falaAjenos = 0;
// sku → sellerId leído de la ficha, para rellenar products.seller y no repetir el trabajo.
const sellerResuelto = new Map();

function precioDeVariante(v) {
  const por = {};
  for (const p of v?.prices ?? []) {
    const n = Number(String(Array.isArray(p.price) ? p.price[0] : p.price).replace(/[^0-9.]/g, ''));
    if (p.type && Number.isFinite(n)) por[p.type] = n;
  }
  const online = [por.internetPrice, por.eventPrice].filter((x) => x != null);
  return online.length ? Math.min(...online) : null;
}

async function viva(url, sku, precioEsperado, vendedorConocido) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status >= 400) return false;
    if (MUERTA.test(res.url)) return false; // 200 tras redirigir a su página de 404

    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    // Si no se puede parsear y encima NO sabíamos de quién era el producto, se descarta: de los
    // 213 candidatos con vendedor desconocido, 189 (89%) resultaron ser de terceros. Aceptar a
    // ciegas es apostar a uno contra nueve. Con vendedor ya conocido sí se acepta: el fallo de
    // parseo no debe castigar a un producto que ya sabemos que es de la tienda.
    if (!m) { falaSinParsear++; return !!vendedorConocido; }
    const pd = JSON.parse(m[1])?.props?.pageProps?.productData;
    const v = pd?.variants?.find((x) => String(x.id) === String(sku)) ?? pd?.variants?.[0];
    if (!v) { falaSinParsear++; return !!vendedorConocido; }

    // Vendedor: la ficha lo trae aunque el listado no lo haya vuelto a ver.
    const vendedor = v.offerings?.[0]?.sellerId ?? pd.sellerInfo?.sellerId ?? null;
    if (vendedor) {
      sellerResuelto.set(String(sku), vendedor);
      if (vendedor !== FALABELLA_PRIMERA_PARTE) { falaAjenos++; return false; }
    } else if (!vendedorConocido) {
      falaSinParsear++;
      return false; // desconocido y la ficha tampoco lo dice: no se publica a ciegas
    }

    if (v.isPurchaseable === false || pd.isOutOfStock === true) return false;
    const precio = precioDeVariante(v);
    if (precio != null && Math.abs(Math.round(precio * 100) - precioEsperado) > 50) return false;
    return true;
  } catch {
    return true; // ante un fallo de red no castigamos al producto: se revisa en la próxima corrida
  }
}

if (REVERIFICAR) {
  const pub = await query(`
    SELECT o.product_fk AS id, o.precio AS cur_online, p.retailer, p.sku, p.product_id, p.slug, p.seller
    FROM ofertas o JOIN products p ON p.id = o.product_fk
  `);
  log(`[reverificar] ${pub.length} ofertas publicadas`);
  if (!pub.length) process.exit(0);

  const okVtex = await verificarVtex(pub);
  const esFala = (c) => BY_ID[c.retailer].name === 'falabella';
  const caducadas = [];
  for (const c of pub.filter((x) => !esFala(x))) if (!okVtex.has(c.id)) caducadas.push(c.id);

  const fala = pub.filter(esFala);
  for (let i = 0; i < fala.length; i += CONCURRENCIA) {
    const trozo = fala.slice(i, i + CONCURRENCIA);
    const res = await Promise.all(trozo.map((c) =>
      viva(decodeUrl(BY_ID[c.retailer], c.product_id, c.slug), c.sku, c.cur_online, c.seller)));
    res.forEach((ok, j) => { if (!ok) caducadas.push(trozo[j].id); });
    await new Promise((r) => setTimeout(r, 250));
  }

  if (caducadas.length) {
    for (let i = 0; i < caducadas.length; i += 50) {
      await exec(`DELETE FROM ofertas WHERE product_fk IN (${caducadas.slice(i, i + 50).join(',')});`);
    }
  }
  log(`[reverificar] ${caducadas.length} retiradas por agotarse o cambiar de precio; quedan ${pub.length - caducadas.length}`);
  process.exit(0);
}


// Rellena products.seller con lo leído de las fichas. Así un producto que el listado dejó de
// mostrar deja de ser "desconocido" para siempre: la próxima corrida ya sabe de quién es y no
// hay que volver a abrir su ficha. El coste se paga una vez y decrece solo.
async function guardarSellers() {
  if (!sellerResuelto.size) return;
  const dic = new Map((await query('SELECT id, name FROM sellers')).map((r) => [r.name, r.id]));
  const nuevos = [...new Set([...sellerResuelto.values()].filter((v) => !dic.has(v)))];
  if (nuevos.length) {
    for (const n of nuevos) await exec(`INSERT OR IGNORE INTO sellers (name) VALUES ('${n.replace(/'/g, "''")}')`);
    for (const r of await query('SELECT id, name FROM sellers')) dic.set(r.name, r.id);
  }
  const fila = RETAILERS.falabella.id;
  const stmts = [...sellerResuelto].map(([sku, v]) =>
    `UPDATE products SET seller=${dic.get(v) ?? 'NULL'} WHERE retailer=${fila} AND sku='${String(sku).replace(/'/g, "''")}'`);
  for (let i = 0; i < stmts.length; i += 25) await exec(stmts.slice(i, i + 25).join(';\n') + ';');
  log(`[ofertas] vendedor resuelto y guardado en ${stmts.length} productos que el listado ya no muestra`);
}

// Cada tienda se verifica con lo que expone: VTEX por su API de catálogo, Falabella leyendo el
// __NEXT_DATA__ de la ficha que ya se descargaba. Las cuatro quedan con el mismo criterio —
// fuera si está agotado o si el precio ya no coincide.
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
    return viva(decodeUrl(r, c.product_id, c.slug), c.sku, c.cur_online, c.seller);
  }));
  res.forEach((ok, j) => (ok ? vivas.push(trozo[j]) : muertas++));
  await new Promise((r) => setTimeout(r, 250));
}
await guardarSellers();
log(`[ofertas] Falabella: ${fala.length - muertas} de ${fala.length} siguen comprables y al mismo precio` +
    (falaAjenos ? `; ${falaAjenos} descartadas por ser de terceros (vendedor resuelto en la ficha)` : '') +
    (falaSinParsear ? ` (${falaSinParsear} con la ficha ilegible: se aceptan si ya sabíamos que` +
      ` eran de Falabella y se descartan si no)` : ''));

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
    `INSERT INTO ofertas (product_fk, ref, precio, caida, calculado, bajo) ` +
    `VALUES (${c.id},${c.ref},${c.cur_online},${c.caida},${ahora},${c.bajo ?? 'NULL'})`
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
