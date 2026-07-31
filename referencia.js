// LA REFERENCIA DE PRECIO DE CAZA PRECIO — el "antes" de cada oferta, en un solo sitio.
//
// Está aquí y no en ofertas.js porque hay tres consumidores y el 2026-07-31 se comprobó lo que
// pasa cuando cada uno lleva su copia: al cambiar el criterio en ofertas.js, `porque-no.js`
// siguió explicando descartes con la regla vieja y `auditoria.js` siguió auditando un algoritmo
// que ya no existía. Un diagnóstico que miente es peor que no tener diagnóstico, porque se
// consulta justo cuando uno desconfía del resultado. Misma barrera de paridad que schema-v2.js.
//
// ---------------------------------------------------------------------------------------------
// QUÉ ES LA REFERENCIA Y POR QUÉ ES ASÍ
//
// Es la MENOR de dos medidas, más el precio de lista que declara la tienda. Nunca se sube para
// poder anunciar más; sólo se baja.
//
//   (1) MÍNIMO PREVIO — el precio más bajo al que estuvo el producto ANTES del régimen de precio
//       actual. Es lo que hace inmune al truco de subir para poder rebajar: alargar un pico no
//       baja ningún mínimo, así que la duración de la subida deja de ser una palanca.
//
//       Lo trajo el parlante Sony SRS-ULT10 de Promart (2026-07-31), que era la oferta #1 del
//       carrusel anunciada "de S/999 a S/279, -72%":
//           13-jul  S/269 ┐ 8.24 d antes del pico
//           19-jul  S/279 ┘
//           22-jul  S/999   9.00 d  ← el pico ocupa el 52% del tiempo observado
//           31-jul  S/279           ← su precio de siempre, anunciado como -72%
//       Con el pico ocupando más de la mitad del tiempo, la mediana ponderada ES el precio
//       inflado. No es un fallo de implementación: es el límite del estadístico, y le pasa a toda
//       la familia —mediana, percentiles, "precio sostenido"— porque todas miden PROPORCIÓN DE
//       TIEMPO, y quien manipula controla cuánto dura la subida.
//
//   (2) MEDIANA PONDERADA POR TIEMPO — el precio por debajo del cual el producto pasó la mitad de
//       su vida. Ya no sostiene la referencia sola, pero se conserva porque aporta lo único que
//       al mínimo previo le falta: EXPIRA. Cuando el precio rebajado lleva más de la mitad del
//       tiempo, la mediana baja hasta él y el producto deja de anunciarse — a esas alturas ya no
//       es una rebaja, es su precio nuevo. Medido el 31-jul: el mínimo previo a solas daba 1,015
//       candidatas contra 413 de la mediana, y el 64% de ellas habían bajado hacía 8 días o más.
//       Con las dos, 312 — la intersección exacta, más estricta que cualquiera por separado.
//
// El resultado no tiene ningún parámetro que calibrar, que era la otra mitad del problema: los
// umbrales de "sostenido" se eligen a ojo y se pueden esquivar.
// ---------------------------------------------------------------------------------------------

export const DIAS_VENTANA = 90; // historia que entra; hoy sobra, en octubre no

/**
 * Devuelve las CTE que calculan la referencia, para pegar detrás de un `WITH`.
 * Expone `sostenidos(product_fk, ref)` —la referencia final— y deja a la vista `base`
 * y `mediana` por separado, que es lo que necesita el diagnóstico para decir cuál de las dos
 * manda en cada producto. `pts` queda disponible con ts, precio, stock y duración.
 *
 * @param {string} ahora  Expresión SQL del "momento actual". La auditoría retro-simula pasando
 *                        el corte, y por eso `dur` se recorta ahí: un punto vigente al llegar el
 *                        corte no puede durar más allá de él. En vivo, recortar no hace nada.
 * @param {number} dias   Ventana de historia.
 * @param {string} filtro Condición extra sobre price_points (p. ej. `AND product_fk IN (…)`).
 */
export function sqlReferencia({ ahora = "strftime('%s','now')", dias = DIAS_VENTANA, filtro = '' } = {}) {
  return `
  pts AS (
    SELECT product_fk, ts, price_online, in_stock,
           LAG(price_online) OVER (PARTITION BY product_fk ORDER BY ts) AS ant,
           MIN(COALESCE(LEAD(ts) OVER (PARTITION BY product_fk ORDER BY ts), ${ahora}), ${ahora}) - ts AS dur
    FROM price_points
    WHERE ts >= ${ahora} - ${dias} * 86400 AND ts <= ${ahora} ${filtro}
  ),
  -- Inicio del régimen de precio actual = primera fila del último tramo de precio igual. No vale
  -- la última fila a secas: la base escribe fila también cuando cambian stock o tarjeta, así que
  -- hay filas consecutivas al mismo precio (3499 → 3499). Medido el 31-jul, usar el tramo en vez
  -- de la fila conserva 4 ofertas más sin dejar entrar ninguna falsa.
  inicio AS (
    SELECT product_fk, MAX(ts) AS desde
    FROM pts
    WHERE ant IS NULL OR price_online <> ant
    GROUP BY product_fk
  ),
  minimo_previo AS (
    SELECT p.product_fk, MIN(p.price_online) AS ref
    FROM pts p JOIN inicio i ON i.product_fk = p.product_fk
    WHERE p.ts < i.desde
    GROUP BY p.product_fk
  ),
  -- (1b) LA EXCEPCIÓN DE LA ESCALERA. El mínimo previo castiga la rebaja progresiva: en
  -- 199 → 149 → 129 toma como "antes" el escalón anterior (149) y no donde empezó la bajada
  -- (199), así que un descuento real del 35% se queda en un 13% y no se publica. Le pasaba a las
  -- cámaras Tenda y a la blusa Almat, cuyo precio de lista declarado por la tienda confirma la
  -- referencia alta (S/259 y S/139).
  --
  -- Cuando el producto NUNCA subió de precio en la ventana, la referencia es el precio con el que
  -- empezó — que en una serie no creciente es su máximo. El máximo se abandonó el 28-jul por
  -- frágil ante un pico, pero aquí no puede haberlo: un pico ES una subida, y basta una para que
  -- esta rama se desactive y vuelva a mandar el mínimo previo. Quien manipula tiene que subir el
  -- precio, así que no puede alcanzar este caso.
  --
  -- Medido el 31-jul: 1,148 productos con escalera estrictamente descendente, de los que se
  -- recuperan 3 ofertas. Poco hoy, pero es un sesgo sistemático contra las rebajas progresivas,
  -- que son la norma en moda.
  variacion AS (
    SELECT product_fk,
           SUM(CASE WHEN ant IS NOT NULL AND price_online > ant THEN 1 ELSE 0 END) AS subidas,
           MAX(price_online) AS maximo
    FROM pts
    GROUP BY product_fk
  ),
  base AS (
    SELECT mp.product_fk,
           CASE WHEN v.subidas = 0 THEN v.maximo ELSE mp.ref END AS ref
    FROM minimo_previo mp
    JOIN variacion v ON v.product_fk = mp.product_fk
  ),
  acum AS (
    SELECT product_fk, price_online,
           SUM(dur) OVER (PARTITION BY product_fk ORDER BY price_online
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS hasta_aqui,
           SUM(dur) OVER (PARTITION BY product_fk) AS total
    FROM pts
  ),
  mediana AS (
    SELECT product_fk, MIN(price_online) AS ref
    FROM acum
    WHERE total > 0 AND hasta_aqui >= total / 2.0
    GROUP BY product_fk
  ),
  sostenidos AS (
    SELECT b.product_fk, MIN(b.ref, md.ref) AS ref
    FROM base b JOIN mediana md ON md.product_fk = b.product_fk
  )`;
}
