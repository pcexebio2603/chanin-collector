// Cliente mínimo de la API pública de catálogo VTEX.
import { SETTINGS } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= SETTINGS.retries; attempt++) {
    if (attempt > 0) await sleep(SETTINGS.retryBaseMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': SETTINGS.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(SETTINGS.timeoutMs),
      });
      // VTEX responde 206 (Partial Content) en búsquedas paginadas; 200 en el árbol.
      if (res.status === 200 || res.status === 206) return await res.json();
      // 429/5xx: reintentar; otros códigos: rendirse ya.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} en ${url}`);
        continue;
      }
      throw new Error(`HTTP ${res.status} en ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function categoryTree(base) {
  return getJson(`${base}/api/catalog_system/pub/category/tree/${SETTINGS.treeDepth}`);
}

// Devuelve las categorías hoja bajo las raíces configuradas (para esquivar el tope de 2500).
// OJO: el filtro fq=C exige la RUTA completa de ids (C:/160/167/205/), no el id suelto
// (verificado en Oechsle 2026-07-13: el id suelto de una hoja devuelve 0 resultados).
export function leavesUnder(tree, rootIds) {
  const leaves = [];
  const walk = (node, inside, path) => {
    const within = inside || rootIds.includes(node.id);
    const newPath = [...path, node.id];
    const children = node.children ?? [];
    if (within && children.length === 0)
      leaves.push({ path: newPath.join('/'), name: node.name });
    for (const child of children) walk(child, within, newPath);
  };
  for (const node of tree) walk(node, false, []);
  return leaves;
}

// Itera todos los productos de una categoría, paginando de a pageSize.
export async function* productsInCategory(base, categoryPath, { maxPages = Infinity } = {}) {
  const { pageSize, maxOffset, delayMs } = SETTINGS;
  for (let page = 0, from = 0; page < maxPages && from <= maxOffset; page++, from += pageSize) {
    const to = from + pageSize - 1;
    const url = `${base}/api/catalog_system/pub/products/search?fq=C:/${categoryPath}/&_from=${from}&_to=${to}&O=OrderByTopSaleDESC`;
    const batch = await getJson(url);
    if (!Array.isArray(batch) || batch.length === 0) return;
    yield batch;
    if (batch.length < pageSize) return;
    await sleep(delayMs);
  }
}

// Normaliza un producto VTEX a filas por SKU.
// Precio con tarjeta Oh, derivado del teaser de promoción (validado 100% vs. PDP, ver
// 09-precio-tarjeta-vtex.md): PriceWithoutDiscount − máximo(descuento absoluto de teasers Oh).
// Guarda: solo si 0 < tarjeta < online (rechaza porcentuales u otros efectos mal interpretados).
export function ohCardPrice(offer) {
  const pwd = offer.PriceWithoutDiscount;
  const online = offer.Price;
  if (pwd == null || online == null) return null;
  const teasers = offer.Teasers ?? offer.teasers ?? [];
  let maxDisc = 0;
  for (const t of teasers) {
    if (!/tarjeta|\boh\b/i.test(JSON.stringify(t))) continue;
    const eff = t['<Effects>k__BackingField'] ?? t.effects ?? {};
    const params = eff['<Parameters>k__BackingField'] ?? eff.parameters ?? [];
    for (const p of params) {
      const name = p['<Name>k__BackingField'] ?? p.name ?? '';
      if (/PromotionalPriceTableItemsDiscount$/i.test(name)) {
        const v = parseFloat(p['<Value>k__BackingField'] ?? p.value);
        if (Number.isFinite(v) && v > maxDisc) maxDisc = v;
      }
    }
  }
  if (maxDisc <= 0) return null;
  const card = Math.round((pwd - maxDisc) * 100) / 100;
  return card > 0 && card < online ? card : null;
}

export function normalize(product, retailer, base, categoryName) {
  const rows = [];
  for (const item of product.items ?? []) {
    const offer = item.sellers?.[0]?.commertialOffer;
    if (!offer || offer.Price == null || offer.Price === 0) continue;
    // Precio con tarjeta Oh normalizado al mismo formato que Falabella (cmrPrice) → {price}.
    const oh = ohCardPrice(offer);
    const cardTeaser = oh != null ? { type: 'ohPrice', price: oh, label: 'Oh' } : null;
    rows.push({
      retailer,
      product_id: String(product.productId),
      sku: String(item.itemId),
      name: product.productName ?? item.name ?? '',
      brand: product.brand ?? '',
      category: categoryName,
      url: `${base}/${product.linkText}/p`,
      image: item.images?.[0]?.imageUrl ?? '',
      price_online: offer.Price,
      price_list: offer.ListPrice || null,
      card_teaser: cardTeaser ? JSON.stringify(cardTeaser) : null,
      in_stock: offer.AvailableQuantity > 0 ? 1 : 0,
    });
  }
  return rows;
}
