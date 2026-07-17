// Resumen rápido del estado de la BD: node stats.js
import { openDb, DB_PATH } from './db.js';

const db = openDb();
console.log(`BD: ${DB_PATH}\n`);
console.log('— Productos por retailer —');
for (const r of db.prepare(
  `SELECT retailer, COUNT(*) n, MIN(first_seen) desde FROM products GROUP BY retailer`
).all()) console.log(`  ${r.retailer}: ${r.n} SKUs (desde ${r.desde?.slice(0, 10)})`);

console.log('\n— Puntos de precio —');
for (const r of db.prepare(
  `SELECT p.retailer, COUNT(*) n, COUNT(DISTINCT pp.date) dias
   FROM price_points pp JOIN products p ON p.id = pp.product_fk GROUP BY p.retailer`
).all()) console.log(`  ${r.retailer}: ${r.n} puntos en ${r.dias} días`);

console.log('\n— Últimas corridas —');
for (const r of db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 6`).all())
  console.log(
    `  ${r.ts.slice(0, 16)} ${r.retailer}: ${r.status} · ${r.products} SKUs · ${r.changes} cambios · ${r.errors} err · ${Math.round(r.duration_ms / 1000)}s`
  );
db.close();
