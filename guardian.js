// Guardián de Caza Precio: revisa cada oferta ANTES de publicarla y aparta la que no se sostiene.
//
// POR QUÉ EXISTE. Los dos fallos que llegaron al carrusel en producción los detectó Pablo
// mirando la web, no el sistema: un BookCover anunciado con stock cuando estaba agotado, y un
// Ryzen anunciado "-50%" cuando la propia tienda declaraba un precio normal muy inferior.
// Depender de que alguien mire no es un control de calidad.
//
// EL PRINCIPIO. Ninguno de esos dos casos era un dato corrupto: eran señales que se
// CONTRADECÍAN. Recogemos varias cosas sobre el mismo producto —nuestra medición, el precio de
// lista que declara la tienda, su precio y stock en vivo, y el mismo producto en otras tiendas—
// y todas deberían contar la misma historia. Cuando no concuerdan, hay algo mal aunque nadie
// haya previsto ese caso concreto. Eso generaliza; una lista de reglas ad-hoc, no.
//
// LO QUE NO HACE. No detecta un precio que sea absurdo pero coherente en todas las señales (una
// tienda que lleva meses pidiendo de más por algo, sin contradecirse). Para eso hace falta una
// referencia externa de mercado, que hoy no tenemos.
//
// Lo apartado NO se descarta en silencio: va a la tabla `cuarentena` con su motivo, para poder
// revisar qué se está atrapando y descubrir patrones nuevos.
import { query, exec } from './d1-client.js';
import { BY_ID } from './schema-v2.js';

// Casos que llegaron a producción y nunca deben volver. Si alguno reaparece, algo se rompió al
// tocar el detector: es una prueba de regresión permanente, no una lista negra.
const CANARIOS = [
  { tienda: 'falabella', sku: '21386335', que: 'Puma Court Lally — referencia inflada por un pico de 3 días' },
  { tienda: 'plazavea', sku: '12467620', que: 'BookCover Samsung — publicado con stock estando agotado' },
  { tienda: 'oechsle', sku: '1001296731', que: 'Ryzen 5 3600 — referencia por encima del precio de lista' },
  { tienda: 'plazavea', sku: '11876027', que: 'Ryzen 5 3600 (Plaza Vea)' },
  { tienda: 'promart', sku: '1001432907', que: 'Ryzen 5 3600 (Promart)' },
];

const DISCREPANCIA_TIENDAS = 1.20; // referencias que difieren más de esto entre tiendas
const ATIPICA_CATEGORIA = 1.8;     // caída frente a la media de su categoría
const MIN_MUESTRA_CATEGORIA = 5;

export async function revisar(cands) {
  const motivos = new Map(); // id → motivo
  const marcar = (id, motivo) => { if (!motivos.has(id)) motivos.set(id, motivo); };
  const porId = new Map(cands.map((c) => [c.id, c]));

  // ── Señal 1: la misma oferta en varias tiendas con referencias que no cuadran ───────────────
  // Los catálogos Intercorp están sincronizados al céntimo, así que una referencia que se sale
  // del grupo delata que nuestra medición de ESA tienda está sesgada.
  const porNombre = new Map();
  const nombres = await query(`
    SELECT p.id, p.name FROM products p WHERE p.id IN (${cands.map((c) => c.id).join(',')})
  `);
  for (const n of nombres) {
    if (!porNombre.has(n.name)) porNombre.set(n.name, []);
    porNombre.get(n.name).push(n.id);
  }
  for (const ids of porNombre.values()) {
    if (ids.length < 2) continue;
    const refs = ids.map((i) => porId.get(i)?.ref).filter(Boolean);
    if (refs.length < 2) continue;
    if (Math.max(...refs) > Math.min(...refs) * DISCREPANCIA_TIENDAS) {
      for (const i of ids) marcar(i, 'referencias que no cuadran entre tiendas');
    }
  }

  // ── Señal 2: caída atípica dentro de su propia categoría ───────────────────────────────────
  // No sabemos qué precio es "razonable" para un producto, pero sí qué descuento es normal en su
  // categoría. Una caída muy fuera de esa norma merece una mirada.
  const cats = await query(`
    SELECT p.id, c.name AS cat FROM products p
    JOIN categories c ON c.id = p.category
    WHERE p.id IN (${cands.map((c) => c.id).join(',')})
  `);
  const porCat = new Map();
  for (const r of cats) {
    if (!porCat.has(r.cat)) porCat.set(r.cat, []);
    porCat.get(r.cat).push(r.id);
  }
  for (const ids of porCat.values()) {
    if (ids.length < MIN_MUESTRA_CATEGORIA) continue;
    const caidas = ids.map((i) => porId.get(i)?.caida).filter((x) => x != null);
    const media = caidas.reduce((a, b) => a + b, 0) / caidas.length;
    for (const i of ids) {
      const c = porId.get(i);
      if (c && c.caida > media * ATIPICA_CATEGORIA) marcar(i, 'caída muy fuera de la norma de su categoría');
    }
  }

  // ── Señal 3: canarios ──────────────────────────────────────────────────────────────────────
  const canarios = [];
  const idsCanario = await query(`
    SELECT p.id, p.sku, rt.name AS tienda FROM products p
    JOIN retailers rt ON rt.id = p.retailer
    WHERE (${CANARIOS.map((c) => `(rt.name='${c.tienda}' AND p.sku='${c.sku}')`).join(' OR ')})
  `);
  for (const c of idsCanario) {
    if (porId.has(c.id)) {
      const def = CANARIOS.find((x) => x.tienda === c.tienda && x.sku === c.sku);
      canarios.push(def);
      marcar(c.id, 'CANARIO: caso conocido que no debe reaparecer');
    }
  }

  const limpias = cands.filter((c) => !motivos.has(c.id));
  return { limpias, motivos, canarios };
}

// Deja constancia de lo apartado, para poder revisarlo y descubrir patrones nuevos.
export async function registrar(motivos, porId) {
  await exec(`
    CREATE TABLE IF NOT EXISTS cuarentena (
      product_fk INTEGER PRIMARY KEY, motivo TEXT NOT NULL, ref INTEGER, precio INTEGER, ts INTEGER NOT NULL
    );
  `);
  const ahora = Math.floor(Date.now() / 1000);
  await exec('DELETE FROM cuarentena;');
  const filas = [...motivos].map(([id, motivo]) => {
    const c = porId.get(id);
    return `INSERT INTO cuarentena (product_fk, motivo, ref, precio, ts) ` +
           `VALUES (${id}, '${motivo.replace(/'/g, "''")}', ${c?.ref ?? 'NULL'}, ${c?.cur_online ?? 'NULL'}, ${ahora})`;
  });
  for (let i = 0; i < filas.length; i += 25) {
    await exec(filas.slice(i, i + 25).join(';\n') + ';');
  }
}

export function resumen(motivos) {
  const cuenta = new Map();
  for (const m of motivos.values()) cuenta.set(m, (cuenta.get(m) ?? 0) + 1);
  return [...cuenta].sort((a, b) => b[1] - a[1]);
}

export { BY_ID };
