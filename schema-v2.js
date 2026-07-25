// Codificación del esquema v2 de la D1. Funciones puras, sin dependencias: las comparte el
// colector (al escribir) y el Worker (al leer). Debe mantenerse en paridad EXACTA con el SQL
// de migración; cualquier divergencia rompe la reconstrucción de url/image.
//
// El principio es que v2 no pierde información: guarda el tramo variable de cada cadena y
// reconstruye el original byte a byte. Única excepción deliberada: el cache-buster `?v=` de
// las imágenes VTEX, verificado como prescindible (responden 200 sin él).

export const RETAILERS = {
  oechsle: {
    id: 1, name: 'oechsle',
    urlPfx: 'https://www.oechsle.pe/',
    imgPfx: 'https://oechsle.vteximg.com.br/arquivos/ids/',
    cardType: 'ohPrice', cardLabel: 'Oh',
  },
  plazavea: {
    id: 2, name: 'plazavea',
    urlPfx: 'https://www.plazavea.com.pe/',
    imgPfx: 'https://plazavea.vteximg.com.br/arquivos/ids/',
    cardType: 'ohPrice', cardLabel: 'Oh',
  },
  promart: {
    id: 3, name: 'promart',
    urlPfx: 'https://www.promart.pe/',
    imgPfx: 'https://promart.vteximg.com.br/arquivos/ids/',
    cardType: 'ohPrice', cardLabel: 'Oh',
  },
  falabella: {
    id: 4, name: 'falabella',
    // En falabella el product_id va dentro de la url, así que el prefijo se completa por fila.
    urlPfx: 'https://www.falabella.com.pe/falabella-pe/product/',
    imgPfx: 'https://media.falabella.com.pe/falabellaPE/',
    cardType: 'cmrPrice', cardLabel: 'CMR',
  },
};

export const BY_ID = Object.fromEntries(Object.values(RETAILERS).map((r) => [r.id, r]));

const esFalabella = (r) => r.id === 4;
const urlPrefijo = (r, productId) => r.urlPfx + (esFalabella(r) ? productId + '/' : '');

// ---- url ---------------------------------------------------------------------------------
// Si la url no sigue el patrón del retailer se guarda entera; se reconoce porque un slug real
// nunca empieza por 'https://'. Así ninguna fila queda sin poder reconstruirse.
export function encodeUrl(r, productId, url) {
  if (url == null) return null;
  const pfx = urlPrefijo(r, productId);
  return url.startsWith(pfx) ? url.slice(pfx.length) : url;
}

export function decodeUrl(r, productId, slug) {
  if (slug == null) return null;
  return slug.startsWith('https://') ? slug : urlPrefijo(r, productId) + slug;
}

// ---- image -------------------------------------------------------------------------------
// img_var: 0 literal · 1 falabella _1 · 2 falabella _01 · 3 falabella _001 · 4 vtex (tramo ids/archivo)
const SUFIJOS_FALABELLA = { 1: '_1/public', 2: '_01/public', 3: '_001/public' };

export function encodeImage(r, sku, image) {
  if (image == null) return { img_var: 0, img: null };
  if (esFalabella(r)) {
    for (const [v, sufijo] of Object.entries(SUFIJOS_FALABELLA)) {
      if (image === r.imgPfx + sku + sufijo) return { img_var: Number(v), img: null };
    }
    return { img_var: 0, img: image };
  }
  if (!image.startsWith(r.imgPfx)) return { img_var: 0, img: image };
  const resto = image.slice(r.imgPfx.length);
  const v = resto.indexOf('?v=');
  return { img_var: 4, img: v >= 0 ? resto.slice(0, v) : resto };
}

export function decodeImage(r, sku, img_var, img) {
  if (img_var === 0) return img ?? null;
  if (img_var === 4) return r.imgPfx + img;
  return r.imgPfx + sku + SUFIJOS_FALABELLA[img_var];
}

// ---- precios y tiempos --------------------------------------------------------------------
// Todos los precios de la base son exactos a 2 decimales (verificado: 0 filas con más), así que
// los céntimos en INTEGER son sin pérdida y ocupan 2-4 bytes en vez de los 8 fijos de REAL.
export const aCentimos = (n) => (n == null ? null : Math.round(n * 100));
export const deCentimos = (c) => (c == null ? null : c / 100);

// Techo de cordura: nada en estas cuatro tiendas vale un millón de soles. El corte es a
// propósito muy alto — la franja S/50,000-100,000 está llena de precios REALES (LG 97" OLED
// a S/89,999, plotters HP DesignJet, servidores HPE del marketplace de Falabella), así que un
// umbral bajo borraría datos buenos.
//
// Lo que esto NO filtra, y no debe: los placeholders de catálogo (S/9,899, S/99,999) son
// valores plausibles en sí mismos y sólo se delatan comparados con SU producto — una Lenovo
// IdeaPad Slim 3 a S/99,999 es absurda, un LG 97" a S/89,999 no. Eso es trabajo del filtro de
// credibilidad de Caza Precio (04 §8), que exige que el precio haya vivido días en el historial.
// Tampoco filtra errores del vendedor plausibles: la tienda los publicó y registrar lo que la
// tienda muestra es la premisa del producto.
export const PRECIO_MAX_CENTIMOS = 100_000_000; // S/1,000,000

export const precioSano = (centimos) =>
  centimos != null && Number.isFinite(centimos) && centimos > 0 && centimos <= PRECIO_MAX_CENTIMOS;

export const aEpoch = (iso) => (iso == null ? null : Math.floor(Date.parse(iso) / 1000));
export const deEpoch = (s) => (s == null ? null : new Date(s * 1000).toISOString());

// ---- card_teaser ---------------------------------------------------------------------------
// v1 guardaba el JSON completo; v2 sólo el precio en céntimos. El tipo y la etiqueta se derivan
// del retailer (verificado 1:1 en los datos: falabella→cmrPrice/CMR, VTEX→ohPrice/Oh).
// El blob de reglas de promoción VTEX (sin .price) se descarta: cardPrice() ya devolvía null.
export function encodeCard(teaser) {
  if (teaser == null) return null;
  try {
    const t = typeof teaser === 'string' ? JSON.parse(teaser) : teaser;
    return typeof t?.price === 'number' ? aCentimos(t.price) : null;
  } catch {
    return null;
  }
}

export function decodeCard(r, centimos) {
  if (centimos == null) return null;
  return JSON.stringify({ type: r.cardType, price: deCentimos(centimos), label: r.cardLabel });
}
