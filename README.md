# chanin-collector

Colector de precios de e-commerce peruano (Oechsle, Plaza Vea, Promart, Falabella) del proyecto **Chanin**. Corre en GitHub Actions 2 veces al día y escribe los cambios de precio directamente a una base **Cloudflare D1** (la que sirve la extensión). Sin estado local: la detección de "solo cambios" se hace contra la tabla `current_prices` en D1.

## Cómo corre

- `.github/workflows/collect.yml` — cron 2×/día (o `workflow_dispatch` a mano).
- `node collect.js --target d1` → VTEX (API pública de catálogo).
- `node falabella/collect-falabella.js --target d1` → Falabella (API BFF).

## Secreto requerido

- `CLOUDFLARE_API_TOKEN` — token de Cloudflare con permiso **D1 · Edit**. Se configura en *Settings → Secrets and variables → Actions*. La cuenta y el id de la base NO son secretos (van por defecto en `d1-client.js`).

## Local (opcional)

`export CLOUDFLARE_API_TOKEN=... && node collect.js --target d1` escribe a la misma D1. Sin `--target d1` usa un SQLite local (modo de desarrollo).

> Este repo es público solo para tener minutos de Actions ilimitados; contiene únicamente el colector. La estrategia y el resto del proyecto viven en un repo privado aparte.
