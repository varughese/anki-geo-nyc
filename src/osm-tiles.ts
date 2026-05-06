import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";

/** Standard OSM raster tile size. */
export const TILE_PX = 256;

/** https://operations.osmfoundation.org/policies/tiles/ — identify the application. */
export const OSM_TILE_USER_AGENT =
  "anki-geo-nyc/1.0 (personal Anki deck generator; contact: local)";

export interface LatLngBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function worldSizePx(z: number): number {
  return TILE_PX * 2 ** z;
}

/** Web Mercator world pixel coords at integer zoom (origin top-left of the world). */
export function lngLatToWorldPx(lng: number, lat: number, z: number): { x: number; y: number } {
  const s = worldSizePx(z);
  const x = ((lng + 180) / 360) * s;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * s;
  return { x, y };
}

export function worldBoundsForLatLngBox(box: LatLngBox, z: number) {
  const corners: [number, number][] = [
    [box.minLng, box.minLat],
    [box.maxLng, box.minLat],
    [box.minLng, box.maxLat],
    [box.maxLng, box.maxLat],
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lng, lat] of corners) {
    const p = lngLatToWorldPx(lng, lat, z);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const worldW = maxX - minX;
  const worldH = maxY - minY;
  return { minX, maxX, minY, maxY, worldW, worldH };
}

/** Largest zoom level so the bbox still fits in dest pixels (maximizes detail). */
export function pickZoomForViewport(box: LatLngBox, destW: number, destH: number): number {
  const zMin = 4;
  const zMax = 18;
  for (let z = zMax; z >= zMin; z--) {
    const { worldW, worldH } = worldBoundsForLatLngBox(box, z);
    if (worldW <= destW && worldH <= destH) return z;
  }
  return zMin;
}

/**
 * Plan inner map size so canvas aspect matches Web Mercator for the bbox (avoids skewed / "tilted" maps).
 * Uses max z such that worldW <= innerW; innerH follows mercator aspect.
 */
export function planMercatorViewport(box: LatLngBox, innerW: number) {
  const z = pickZoomForViewport(box, innerW, Number.POSITIVE_INFINITY);
  const wb = worldBoundsForLatLngBox(box, z);
  const innerH = innerW * (wb.worldH / wb.worldW);
  return { z, innerH, ...wb };
}

export type TileSourceId = "carto-light-nolabels" | "osm-standard";

export const TILE_SOURCES: Record<
  TileSourceId,
  { url: (z: number, x: number, y: number) => string; attribution: string; cacheSlug: string }
> = {
  "carto-light-nolabels": {
    /** Minimal base: no labels, light palette, fewer visual layers than osm.org raster. */
    url: (z, x, y) =>
      `https://basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png`,
    attribution: "© OpenStreetMap contributors © CARTO",
    cacheSlug: "carto-light_nolabels",
  },
  "osm-standard": {
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: "© OpenStreetMap contributors",
    cacheSlug: "osm-standard",
  },
};

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTilePng(
  url: string,
  cachePath: string,
  rateLimitMs: number
): Promise<Buffer> {
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }
  await sleep(rateLimitMs);
  const res = await fetch(url, {
    headers: { "User-Agent": OSM_TILE_USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Map tile HTTP ${res.status}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, buf);
  return buf;
}

export interface DrawOsmOptions {
  cacheDir: string;
  rateLimitMs: number;
  tileUrl?: (z: number, x: number, y: number) => string;
  /** Subfolder under cacheDir so different providers never share the same path. */
  cacheSlug: string;
}

/**
 * Renders raster map tiles into the given destination rectangle on `ctx`.
 * Returns mercator parameters so polygon overlays use the same projection.
 * @param fixedZ If set, skips auto zoom pick (must match viewport planning).
 */
export async function drawOsmIntoRect(
  ctx: SKRSContext2D,
  box: LatLngBox,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
  options: DrawOsmOptions,
  fixedZ?: number
): Promise<{ z: number; minX: number; minY: number; worldW: number; worldH: number }> {
  const z = fixedZ ?? pickZoomForViewport(box, destW, destH);
  const { minX, maxX, minY, maxY, worldW, worldH } = worldBoundsForLatLngBox(box, z);

  const x0 = Math.floor(minX / TILE_PX);
  const x1 = Math.floor(maxX / TILE_PX);
  const y0 = Math.floor(minY / TILE_PX);
  const y1 = Math.floor(maxY / TILE_PX);

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const mosaic = createCanvas(cols * TILE_PX, rows * TILE_PX);
  const mctx = mosaic.getContext("2d");

  const tileUrl = options.tileUrl ?? TILE_SOURCES["carto-light-nolabels"].url;
  const cacheRoot = path.join(options.cacheDir, options.cacheSlug);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = tileUrl(z, tx, ty);
      const cachePath = path.join(cacheRoot, String(z), String(tx), `${ty}.png`);
      const buf = await fetchTilePng(url, cachePath, options.rateLimitMs);
      const img = await loadImage(buf);
      mctx.drawImage(img, (tx - x0) * TILE_PX, (ty - y0) * TILE_PX);
    }
  }

  const srcX = minX - x0 * TILE_PX;
  const srcY = minY - y0 * TILE_PX;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mosaic, srcX, srcY, worldW, worldH, destX, destY, destW, destH);

  return { z, minX, minY, worldW, worldH };
}

export type MapProjector = (lat: number, lng: number) => { x: number; y: number };

/** Projects WGS84 to canvas pixels matching `drawOsmIntoRect` for the same bbox and canvas size. */
export function makeMercatorProjector(
  z: number,
  minWorldX: number,
  minWorldY: number,
  worldW: number,
  worldH: number,
  padding: number,
  width: number,
  height: number
): MapProjector {
  const innerW = width - 2 * padding;
  const innerH = height - 2 * padding;
  return (lat: number, lng: number) => {
    const p = lngLatToWorldPx(lng, lat, z);
    const relX = p.x - minWorldX;
    const relY = p.y - minWorldY;
    return {
      x: padding + (relX / worldW) * innerW,
      y: padding + (relY / worldH) * innerH,
    };
  };
}

/** Required visible credit when using map tiles (provider-specific). */
export function drawOsmAttribution(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  attributionLine: string
): void {
  const text = attributionLine;
  ctx.save();
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
  const x = width - 6;
  const y = height - 5;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}
