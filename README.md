# anki-geo-nyc

NYC neighborhood map/deck generator for Anki.

This repo contains scripts to:
- parse neighborhood polygons/summaries from `https://locality.nyc` - https://github.com/RichardIvan/corporate-dashboard/blame/eae1cd34ae343462c6fbbdb984e19930543506b7/app/data/geojson/nyc.json might have also worked
- render one map image per neighborhood (borough-focused, OSM/CARTO basemap)
- export Anki-ready JSON that includes summaries + relative image paths

## Current Outputs

- Maps (WebP): `output/neighborhood-maps-webp/<borough>/<neighborhood>.webp`
- Deck JSON: `output/anki/neighborhood-deck.json`

## Stack

- Runtime: Node + TypeScript (`tsx`)
- Image rendering: `@napi-rs/canvas`
- Encoding/compression: `sharp`
- Package manager: `pnpm`

## Important Scripts

- `pnpm generate:maps`
  - Runs `src/generate-neighborhood-maps.ts`
  - Generates **WebP directly** (default quality 82)
  - Default output directory: `output/neighborhood-maps-webp`

- `pnpm generate:deck-json`
  - Runs `src/generate-anki-deck-json.ts`
  - Builds `output/anki/neighborhood-deck.json`
  - Includes:
    - `summaryHtml`
    - `summaryText` (HTML stripped)
    - `imageRelativePath` (e.g. `neighborhood-maps-webp/manhattan/tribeca.webp`)

- `pnpm optimize:images`
  - Runs `src/optimize-neighborhood-images.ts`
  - Optional PNG optimization utility for legacy PNG folders

- `pnpm typecheck`
  - TypeScript `--noEmit`

## End-to-End Workflow

1) Generate/refresh map images:

```bash
pnpm generate:maps
```

2) Generate deck JSON:

```bash
pnpm generate:deck-json
```

3) Use `output/anki/neighborhood-deck.json` + media folder for import tooling.

## Key Generator Defaults (maps)

`src/generate-neighborhood-maps.ts` defaults:
- output format: **WebP**
- output root: `output/neighborhood-maps-webp`
- basemap provider: `carto-light-nolabels`
- map wash: `0.34`
- borough-only framing (not all boroughs at once)
- Mercator-matched height to avoid skew/tilt artifacts

Useful flags:
- `--out <dir>`
- `--webp-quality <1-100>`
- `--no-osm`
- `--tiles carto-light-nolabels|osm-standard`
- `--map-wash <0-1>`
- `--max <n>`

## Deck JSON Schema (current)

Top-level:
- `meta.generatedAt`
- `meta.totalCards`
- `meta.cardsWithImages`
- `meta.cardsMissingImages`
- `meta.imageRoot`
- `meta.imagePrefix`
- `meta.sourceDataPath`
- `cards[]`

Card:
- `id` (`<boroughSlug>__<neighborhoodSlug>`)
- `neighborhood`
- `borough`
- `summaryHtml`
- `summaryText`
- `imageRelativePath`

## File/Script Guide

- `src/generate-neighborhood-maps.ts`
  - Main renderer for neighborhood images
  - Uses borough bbox + cached basemap layer

- `src/osm-tiles.ts`
  - Tile fetching/cache
  - Web Mercator math/projection helpers
  - Attribution rendering

- `src/generate-anki-deck-json.ts`
  - Builds Anki-ready JSON with summaries + image path references

- `src/optimize-neighborhood-images.ts`
  - PNG recompression helper for old PNG exports

- `data/locality-nyc-neighborhoods.json`
  - Source polygons/summaries used by generators

## Notes for Next Agent

- If map generation fails with `ENOENT` on write, ensure parent directories are created right before write (already handled in current code).
- If changing image extension, update both:
  1) generator output extension
  2) deck JSON path builder extension
- If changing output root directory, update deck JSON `--images-root` / `--image-prefix` defaults or pass flags.
- Keep attribution visible when using OSM/CARTO tiles for shared/public artifacts.
