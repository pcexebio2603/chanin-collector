# Colector Falabella — carril datos (proyecto Chanin)

Colector **standalone** de precios de **Falabella Perú**. Falabella NO corre VTEX
(plataforma custom Next.js + Cloudflare), por eso vive aparte del colector VTEX
(`../collect.js`, `../vtex.js`, `../config.js`) y **no los toca**. Reutiliza `../d1-writer.js`:
escribe en la **misma base D1**, **mismo esquema**, misma lógica de
**solo cambios**, con `retailer = 'falabella'`.

Decisión y sondeo técnico que originan este colector: `../../07-decision-falabella.md`.

## Fuente de datos (verificado 2026-07-13)

API JSON del propio front (BFF de listing), accesible **server-side sin evadir nada**:

```
GET /s/browse/v1/listing/pe?categoryId=<cat>&categoryName=<slug>&pgid=2&pid=<uuid>&page=<n>&zones=<zonas>&latLong=<geo>
```

- `pgid=2` es **constante** (tipo de página "listing"), **no** el número de página.
- La paginación real es `page`.
- `pid` debe ser un **UUID válido emitido por el servidor**: un UUID aleatorio se rechaza
  con `404 {"responseType":"Bad Request"}`. El colector **raspa un pid fresco** del HTML de
  una página de categoría al inicio de la corrida (permitido por robots.txt) y cae a un pid
  de respaldo si el raspado falla.
- `zones` + `latLong` (Lima) son obligatorios y acotan precio/stock a una zona real.

Cada producto del listing trae los **tres precios** del retail peruano:
`normalPrice` (lista, tachado) · `internetPrice`/`eventPrice` (online) · `cmrPrice`
(precio con tarjeta CMR — el equivalente de la Oh! de Oechsle, se guarda en `card_teaser`).

## Uso

```bash
# (deps ya instaladas en ../node_modules; el script usa ../db.js)
node collect-falabella.js                        # todas las categorías, corrida completa
node collect-falabella.js --category cat40712    # una sola categoría
node collect-falabella.js --max-pages 2          # corrida acotada (prueba)
```

Requiere `CLOUDFLARE_API_TOKEN` en el entorno. Lo programa el workflow `collect.yml` del repo
`chanin-collector`, que lo ejecuta después del colector VTEX en la misma corrida.

`node ../weekly-check-d1.js --dry` muestra el estado global (ya incluye a falabella).

## Categorías

Lista curada en `CATEGORIES` dentro de `collect-falabella.js` (~22 categorías mid-level de
tecnología, electrohogar y línea blanca; mismo criterio que el colector VTEX). Ampliable:
añadir `{ id, name }` — el `id` sale de la URL `/falabella-pe/category/<id>/<slug>`.

## Programación

Ya no hay cron local. El workflow `collect.yml` del repo `chanin-collector` corre 2 veces al día
(`13 12,0 * * *` UTC) y ejecuta este colector justo después del VTEX, en el mismo job — así no se
solapan y comparten la misma carga de red. Ver `../README.md`.

## Riesgos y línea legal

- **Server-side, sin cuenta, sin evadir** Cloudflare/CAPTCHAs; UA de navegador real;
  rate limit 600 ms + backoff. robots.txt de Falabella **permite** el rastreo del catálogo
  ("todos los robots son bienvenidos"; publica sitemaps de PDP/categorías).
- **Fragilidad conocida:** si Falabella liga el `pid` a sesión o rota su emisión, la API puede
  responder 404 — el colector lo registra como error de categoría (status `parcial`/`fallo`
  en `runs`) y el chequeo semanal lo detecta. Ante 403 persistentes: bajar frecuencia, **no
  evadir** (línea legal de `../../02-analisis-competencia.md` §6).
- **Sin señal fiable de stock** en el listing: `in_stock = 1` cuando hay precio online válido.
