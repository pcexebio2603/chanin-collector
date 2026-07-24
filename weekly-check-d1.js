// Chequeo semanal del colector, versión nube (GitHub Actions + D1). Encapsula el juicio
// del "chequeo de 5 minutos" que antes corría en local contra SQLite:
//   1. La cobertura de historial ("días") creció vs. el chequeo anterior.
//   2. La última corrida de cada retailer dice 'ok'.
//   3. Los 4 retailers (oechsle, plazavea, promart, falabella) siguen presentes.
//   4. Frescura: la última corrida de cada retailer es reciente.
//   5. La última corrida trajo cambios (una corrida sana rara vez trae 0 cambios; nota, no warn).
// El estado previo vive en la tabla `checks` de la propia D1 (el runner es efímero).
// Uso: node weekly-check-d1.js [--dry]   (exit 0 = PASS, 1 = WARN → el workflow falla → email)
// --dry: evalúa y reporta pero NO registra el chequeo (para probar sin mover la línea base).
import fs from 'node:fs';
import { query, exec } from './d1-client.js';

const DRY = process.argv.includes('--dry');

const RETAILERS = ['oechsle', 'plazavea', 'promart', 'falabella'];
const FRESH_DAYS = 2; // el colector corre 2×/día; >2 días sin corrida = algo se cayó

const now = new Date();
const today = now.toISOString().slice(0, 10);

await exec(
  `CREATE TABLE IF NOT EXISTS checks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL,
     dias_total INTEGER NOT NULL,
     detail TEXT,
     verdict TEXT NOT NULL
   )`
);

// Estado previo (último chequeo registrado)
const prevRows = await query(`SELECT date, dias_total, detail FROM checks ORDER BY id DESC LIMIT 1`);
const prev = prevRows[0] ?? null;

// Cobertura actual (~7s en D1 sobre la BD completa)
const diasByRetailer = {};
let diasTotal = 0;
for (const r of await query(
  `SELECT p.retailer, COUNT(DISTINCT pp.date) dias
   FROM price_points pp JOIN products p ON p.id = pp.product_fk GROUP BY p.retailer`
)) {
  diasByRetailer[r.retailer] = r.dias;
  diasTotal += r.dias;
}

// Última corrida por retailer
const lastRunByRetailer = {};
for (const r of await query(
  `SELECT r.retailer, r.ts, r.status, r.products, r.changes
   FROM runs r JOIN (SELECT retailer, MAX(id) mid FROM runs GROUP BY retailer) m ON r.id = m.mid`
)) {
  lastRunByRetailer[r.retailer] = r;
}

// Evaluación
const warns = [];
const notes = [];

if (prev) {
  if (diasTotal > prev.dias_total) {
    notes.push(`"días" creció: ${prev.dias_total} → ${diasTotal} (total sobre los ${RETAILERS.length} retailers).`);
  } else {
    warns.push(
      `"días" NO creció desde el último chequeo (${prev.date}): ${prev.dias_total} → ${diasTotal}. ` +
        `El colector podría no estar corriendo.`
    );
  }
} else {
  notes.push(`Primer chequeo en D1 — línea base "días" total = ${diasTotal}. El crecimiento se evalúa desde el próximo.`);
}

for (const r of RETAILERS) {
  const run = lastRunByRetailer[r];
  if (!run) {
    warns.push(`Retailer ${r}: sin ninguna corrida registrada.`);
    continue;
  }
  if (run.status !== 'ok') {
    warns.push(`Retailer ${r}: última corrida con estado "${run.status}" (esperado "ok").`);
  }
  const ageDays = (now - new Date(run.ts)) / 86400000;
  if (ageDays > FRESH_DAYS) {
    warns.push(`Retailer ${r}: última corrida hace ${ageDays.toFixed(1)} días (>${FRESH_DAYS}). ¿Actions dejó de correr?`);
  }
  if (run.status === 'ok' && run.changes === 0) {
    notes.push(`Retailer ${r}: última corrida ok pero 0 cambios — posible si nada varió, vigilar si se repite.`);
  }
}

const verdict = warns.length === 0 ? 'PASS' : 'WARN';

// Reporte
const lines = [];
lines.push(`# Chequeo semanal del colector — ${today}`);
lines.push('');
lines.push(`**Veredicto: ${verdict}**`);
lines.push('');
lines.push('## Cobertura de historial ("días")');
for (const r of RETAILERS) lines.push(`- ${r}: ${diasByRetailer[r] ?? 0} días`);
lines.push(`- **total: ${diasTotal}**`);
lines.push('');
lines.push('## Últimas corridas');
for (const r of RETAILERS) {
  const run = lastRunByRetailer[r];
  lines.push(
    run
      ? `- ${r}: ${run.status} · ${run.products} SKUs · ${run.changes} cambios · ${String(run.ts).slice(0, 16)}`
      : `- ${r}: (sin corridas)`
  );
}
lines.push('');
if (notes.length) {
  lines.push('## Notas');
  for (const n of notes) lines.push(`- ${n}`);
  lines.push('');
}
if (warns.length) {
  lines.push('## ⚠️ Atención');
  for (const w of warns) lines.push(`- ${w}`);
  lines.push('');
}
const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

// Registrar este chequeo
if (!DRY) {
  await query(`INSERT INTO checks (date, dias_total, detail, verdict) VALUES (?, ?, ?, ?)`, [
    today,
    diasTotal,
    JSON.stringify({ diasByRetailer }),
    verdict,
  ]);
}

process.exit(verdict === 'PASS' ? 0 : 1);
