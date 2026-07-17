// Configuración del colector. Categorías = ids raíz del árbol VTEX (verificados 2026-07-13
// contra /api/catalog_system/pub/category/tree/1 de cada retailer).
// El colector desciende a las hojas del árbol para esquivar el tope de 2500 resultados de VTEX.

export const RETAILERS = {
  oechsle: {
    base: 'https://www.oechsle.pe',
    rootCategories: [
      { id: 160, name: 'Tecnologia' },
      { id: 161, name: 'Electrohogar' },
    ],
  },
  plazavea: {
    base: 'https://www.plazavea.com.pe',
    rootCategories: [
      { id: 678, name: 'Tecnología' },
      { id: 679, name: 'Electrohogar' },
    ],
  },
  promart: {
    base: 'https://www.promart.pe',
    rootCategories: [
      { id: 599, name: 'Electrohogar' },
      { id: 804, name: 'Tecnología' },
      { id: 17, name: 'Herramientas' },
    ],
  },
};

export const SETTINGS = {
  pageSize: 50,            // máximo por request que permite VTEX (_from/_to)
  maxOffset: 2450,         // VTEX corta en 2500 resultados por consulta
  delayMs: 400,            // pausa entre requests (rate limit respetuoso)
  retries: 3,
  retryBaseMs: 2000,       // backoff: 2s, 4s, 8s
  timeoutMs: 25000,
  treeDepth: 3,            // profundidad del árbol de categorías a descender
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
