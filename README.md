# Colector de precios — carril datos (proyecto Chanin)

Colector de precios de **Oechsle, Plaza Vea, Promart** (API pública de catálogo VTEX) y **Falabella** (BFF de listing, colector aparte en `falabella/`). Es la Fase 0 del roadmap (`../06-roadmap.md`): acumula el historial que la extensión muestra. Guarda **solo cambios de precio**.

Corre en **GitHub Actions** contra **Cloudflare D1**, 2 veces al día. No hay backend local: el camino SQLite se retiró el 2026-07-25 (ver *Historia* abajo).

## Uso

```bash
npm install                                        # sin dependencias: sólo fija el lockfile
export CLOUDFLARE_API_TOKEN=...                    # permiso D1 Edit
node collect.js                                    # los 3 retailers VTEX, corrida completa
node collect.js --retailer oechsle --max-pages 1   # prueba acotada
node falabella/collect-falabella.js                # Falabella, corrida completa
node falabella/collect-falabella.js --category cat40712 --max-pages 2
node weekly-check-d1.js --dry                      # chequeo de salud, sin mover la línea base
```

El OAuth de `wrangler login` sirve como `CLOUDFLARE_API_TOKEN` para probar en local sin crear un token aparte.

## Programación

| Workflow | Cron (UTC) | Qué hace |
|---|---|---|
| `collect.yml` | `13 12,0 * * *` | Corrida completa: VTEX y luego Falabella (~190 min) |
| `weekly-check.yml` | `7 17 * * 0` | Chequeo de salud; **WARN → el workflow falla → GitHub envía email** |

El repo es **público** a propósito: los minutos de Actions son ilimitados y una corrida completa no cabría en los 2000 min/mes del tier privado.

> Los correos de fallo llegan a quien **modificó el cron por última vez**, no al dueño del repo. Si empiezan a llegar a la cuenta equivocada, la solución es tocar la línea del cron desde la cuenta correcta.

## Datos (esquema v2)

Ver `../api/schema.sql` para el esquema completo y el porqué de cada decisión.

- `products` — un registro por (retailer, sku), con el **estado actual** incorporado (`cur_online`, `cur_list`, `cur_stock`, `cur_card`). Antes eso vivía en una tabla `current_prices` aparte.
- `price_points` — un punto por cambio: `ts` (epoch), precios en **céntimos**, `card_price`, `in_stock`. Si un SKU no cambia, no se inserta nada.
- `retailers` / `categories` / `brands` — diccionarios; `products` los referencia por id.
- `runs` — bitácora de corridas. `checks` — bitácora del chequeo semanal.

`schema-v2.js` codifica y decodifica ese esquema (url/image comprimidas, céntimos, epoch). **Tiene un gemelo en `../api/schema-v2.js` y ambos deben mantenerse idénticos**: si divergen, la API reconstruye mal las URLs.

## Decisiones técnicas (por qué es así)

- **API VTEX, no HTML ni headless:** `/api/catalog_system/pub/products/search` responde JSON sin autenticación. El filtro de categoría exige la **ruta completa de ids** (`fq=C:/160/167/205/`) — el id suelto de una hoja devuelve vacío.
- **Se desciende a las hojas del árbol de categorías** para esquivar el tope de 2500 resultados por consulta de VTEX.
- **Rate limit respetuoso:** 400ms entre páginas (600 en Falabella), reintentos con backoff, sin evadir bloqueos (línea legal — `../02-analisis-competencia.md` §6). Todo server-side.
- **Solo cambios:** la mayoría de SKUs no cambia a diario; guardar todo inflaría la base sin información.
- **Escritura incremental:** `maybeFlush()` vuelca cada 5,000 cambios al cerrar una categoría. Antes se acumulaba todo y se escribía al final — ese diseño perdió una corrida entera de 3h26m el 2026-07-25 cuando la escritura final falló.
- **Techo de cordura de S/1,000,000** (`precioSano` en `schema-v2.js`): el marketplace de Falabella cuela precios imposibles. Deliberadamente alto — la franja S/50,000-100,000 es real (LG 97" OLED, plotters, servidores).

## Historia

- **2026-07-13** — nace como colector local (SQLite + cron en WSL).
- **2026-07-17** — migrado a GitHub Actions escribiendo directo a D1.
- **2026-07-25** — la D1 toca el tope de 500 MB del plan Free y se pierden corridas. Migración al **esquema v2** (500 MB → 183 MB con los mismos datos) y **retirada del camino local**: `db.js`, `stats.js`, `sync-to-d1.js`, `run.sh`, `weekly-check.js` y la BD `data/precios.db` se eliminaron por estar muertos desde el 17 y haberse quedado en el esquema v1.
