// Cliente mínimo de la API HTTP de Cloudflare D1, para que el colector lea/escriba en la
// nube desde GitHub Actions (sin SQLite local). Account y database id NO son secretos;
// el único secreto es CLOUDFLARE_API_TOKEN (con permiso D1 Edit), que en Actions viene de
// un GitHub secret y en local de colector/.env.d1 (gitignored).
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '76762e9b757ae62bbfc16c488fe1002d';
// Base v2 (esquema comprimido, 2026-07-25). La v1 era 0ae82b97-7597-47ed-9493-3ff995643cc6
// y sigue existiendo como rollback; para volver atrás basta exportar D1_DATABASE_ID con ese id.
const DBID = process.env.D1_DATABASE_ID || '2888a1b9-229a-4200-bc5e-4e18fc6c245b';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DBID}/query`;

async function call(sql, params) {
  if (!TOKEN) throw new Error('Falta CLOUDFLARE_API_TOKEN (env o colector/.env.d1)');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    let res;
    try {
      res = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(params ? { sql, params } : { sql }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      if (attempt === 3) throw e;
      continue; // red transitoria → reintentar
    }
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.success) return j.result;
    // 429/5xx → reintentar; otros → error inmediato
    if (res.status === 429 || res.status >= 500) continue;
    throw new Error(`D1 ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  }
  throw new Error('D1: agotados los reintentos');
}

// SELECT → array de filas.
export async function query(sql, params) {
  const r = await call(sql, params);
  return r[0]?.results ?? [];
}

// Ejecuta 1+ sentencias (separadas por ;). Para lotes de escritura.
export async function exec(sql) {
  return call(sql);
}
