import { Canvas, createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  drawOsmAttribution,
  drawOsmIntoRect,
  makeMercatorProjector,
  planMercatorViewport,
  TILE_SOURCES,
  type TileSourceId,
} from "./osm-tiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type LngLat = [number, number];

interface LocalityPayload {
  meta?: {
    mapViewportBounds?: {
      southWest: { lat: number; lng: number };
      northEast: { lat: number; lng: number };
    };
  };
  neighborhoods: Array<{
    name: string;
    borough: string;
    boundary: { type: string; coordinates: LngLat[][] };
  }>;
}

interface MapBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface Projector {
  (lat: number, lng: number): { x: number; y: number };
}

function parseArgs(argv: string[]) {
  const out: {
    dataPath: string;
    outputDir: string;
    width: number;
    height: number | null;
    paddingPx: number;
    highlightFill: string;
    highlightStroke: string;
    mutedFill: string;
    mutedStroke: string;
    background: string;
    maxCount: number | null;
    dryRun: boolean;
    boroughPadFraction: number;
    useOsm: boolean;
    osmAttribution: boolean;
    tileCacheDir: string;
    osmRateLimitMs: number;
    tileSource: TileSourceId;
    mapWashOpacity: number;
    mutedLineWidth: number;
    highlightLineWidth: number;
    webpQuality: number;
  } = {
    dataPath: path.join(__dirname, "..", "data", "locality-nyc-neighborhoods.json"),
    outputDir: path.join(__dirname, "..", "output", "neighborhood-maps-webp"),
    width: 1200,
    height: null,
    paddingPx: 24,
    highlightFill: "rgba(251, 191, 36, 0.82)",
    highlightStroke: "#b45309",
    mutedFill: "rgba(255, 255, 255, 0.45)",
    mutedStroke: "rgba(15, 23, 42, 0.72)",
    background: "#cbd5e1",
    maxCount: null,
    dryRun: false,
    boroughPadFraction: 0.08,
    useOsm: true,
    osmAttribution: true,
    tileCacheDir: path.join(__dirname, "..", ".cache", "osm-tiles"),
    osmRateLimitMs: 75,
    tileSource: "carto-light-nolabels",
    mapWashOpacity: 0.34,
    mutedLineWidth: 2.35,
    highlightLineWidth: 4,
    webpQuality: 82,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data" && argv[i + 1]) out.dataPath = path.resolve(argv[++i]);
    else if (a === "--out" && argv[i + 1]) out.outputDir = path.resolve(argv[++i]);
    else if (a === "--width" && argv[i + 1]) out.width = Math.max(200, parseInt(argv[++i], 10));
    else if (a === "--height" && argv[i + 1]) out.height = Math.max(200, parseInt(argv[++i], 10));
    else if (a === "--padding" && argv[i + 1]) out.paddingPx = Math.max(0, parseInt(argv[++i], 10));
    else if (a === "--highlight-fill" && argv[i + 1]) out.highlightFill = argv[++i];
    else if (a === "--highlight-stroke" && argv[i + 1]) out.highlightStroke = argv[++i];
    else if (a === "--max" && argv[i + 1]) out.maxCount = parseInt(argv[++i], 10);
    else if (a === "--borough-pad" && argv[i + 1]) {
      out.boroughPadFraction = Math.min(0.45, Math.max(0, parseFloat(argv[++i])));
    } else if (a === "--no-osm") out.useOsm = false;
    else if (a === "--no-osm-attribution") out.osmAttribution = false;
    else if (a === "--tile-cache" && argv[i + 1]) out.tileCacheDir = path.resolve(argv[++i]);
    else if (a === "--osm-rate-ms" && argv[i + 1]) {
      out.osmRateLimitMs = Math.max(0, parseInt(argv[++i], 10));
    } else if (a === "--tiles" && argv[i + 1]) {
      const id = argv[++i] as TileSourceId;
      if (!(id in TILE_SOURCES)) {
        console.error(`Unknown --tiles ${id}. Use: carto-light-nolabels | osm-standard`);
        process.exit(1);
      }
      out.tileSource = id;
    } else if (a === "--map-wash" && argv[i + 1]) {
      out.mapWashOpacity = Math.min(0.95, Math.max(0, parseFloat(argv[++i])));
    } else if (a === "--webp-quality" && argv[i + 1]) {
      out.webpQuality = Math.max(1, Math.min(100, parseInt(argv[++i], 10)));
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: pnpm generate:maps [options]

Renders one borough at a time (zoomed); only polygons in that borough are shown.
Each image highlights one neighborhood. By default the base is **CARTO light no-labels**
(minimal roads, no text); tiles are cached under ./.cache/osm-tiles. Use --no-osm for a plain fill.

Why maps looked "tilted" before: canvas height used a flat lat/lng aspect while tiles use
Web Mercator — height is now matched to Mercator so the basemap is not stretched.

Options:
  --data <path>           JSON from extract-locality-data (default: ./data/locality-nyc-neighborhoods.json)
  --out <dir>             Output directory (default: ./output/neighborhood-maps-webp)
  --width <px>            Canvas width (default: 1200)
  --height <px>           Canvas height (default: proportional to borough bounds)
  --padding <px>          Inset from edges (default: 24)
  --borough-pad <0-1>     Extra margin around borough bbox, fraction of span (default: 0.08)
  --no-osm                Skip map tiles; use solid --background only
  --tiles <id>            carto-light-nolabels (default) | osm-standard
  --tile-cache <dir>      Tile disk cache (default: ./.cache/osm-tiles)
  --osm-rate-ms <n>       Delay between tile downloads (default: 75)
  --map-wash <0-1>        Extra white veil over basemap to mute roads/water lines (default: 0.34)
  --webp-quality <1-100>  Output quality for WebP (default: 82)
  --no-osm-attribution    Hide attribution (not for public decks; CARTO/OSM require credit)
  --highlight-fill <css>  CSS color for focused polygon fill (default: translucent amber)
  --highlight-stroke <css> Stroke for focused polygon (default: #b45309)
  --max <n>               Only render first n neighborhoods (for testing)
  --dry-run               Print paths only, no WebP writes
`);
      process.exit(0);
    }
  }
  return out;
}

function slugPart(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function boundsFromRing(ring: LngLat[]): MapBounds {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lng, lat] of ring) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  return { minLat, maxLat, minLng, maxLng };
}

function mergeBounds(a: MapBounds, b: MapBounds): MapBounds {
  return {
    minLat: Math.min(a.minLat, b.minLat),
    maxLat: Math.max(a.maxLat, b.maxLat),
    minLng: Math.min(a.minLng, b.minLng),
    maxLng: Math.max(a.maxLng, b.maxLng),
  };
}

/** Union bbox of all neighborhoods in a borough (outer ring only). */
function boundsForNeighborhoods(ns: LocalityPayload["neighborhoods"]): MapBounds {
  let u: MapBounds | null = null;
  for (const n of ns) {
    const ring = n.boundary.coordinates[0];
    if (!ring?.length) continue;
    const b = boundsFromRing(ring);
    u = u ? mergeBounds(u, b) : b;
  }
  if (!u) {
    throw new Error("No valid polygons to compute borough bounds");
  }
  return u;
}

function padBounds(b: MapBounds, fraction: number): MapBounds {
  const latSpan = Math.max(b.maxLat - b.minLat, 1e-6);
  const lngSpan = Math.max(b.maxLng - b.minLng, 1e-6);
  const latPad = latSpan * fraction;
  const lngPad = lngSpan * fraction;
  return {
    minLat: b.minLat - latPad,
    maxLat: b.maxLat + latPad,
    minLng: b.minLng - lngPad,
    maxLng: b.maxLng + lngPad,
  };
}

interface BoroughRender {
  height: number;
  project: Projector;
  baseCanvas: Canvas;
}

function makeProjector(
  bounds: MapBounds,
  width: number,
  height: number,
  padding: number
): Projector {
  const w = width - 2 * padding;
  const h = height - 2 * padding;
  const latSpan = bounds.maxLat - bounds.minLat;
  const lngSpan = bounds.maxLng - bounds.minLng;

  return (lat: number, lng: number) => {
    const x = padding + ((lng - bounds.minLng) / lngSpan) * w;
    const y = padding + ((bounds.maxLat - lat) / latSpan) * h;
    return { x, y };
  };
}

function traceRing(ctx: SKRSContext2D, ring: LngLat[], project: Projector): void {
  if (ring.length === 0) return;
  const [firstLng, firstLat] = ring[0];
  const p0 = project(firstLat, firstLng);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < ring.length; i++) {
    const [lng, lat] = ring[i];
    const p = project(lat, lng);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

function drawPolygon(
  ctx: SKRSContext2D,
  coordinates: LngLat[][],
  project: Projector,
  fill: string,
  stroke: string,
  lineWidth: number
): void {
  const outer = coordinates[0];
  if (!outer?.length) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  traceRing(ctx, outer, project);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

/** Softens basemap ink (roads, ferries, etc.) after tiles are drawn. */
function applyBasemapWash(
  ctx: SKRSContext2D,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
  opacity: number
): void {
  if (opacity <= 0) return;
  ctx.save();
  ctx.fillStyle = `rgba(248, 250, 252, ${opacity})`;
  ctx.fillRect(destX, destY, destW, destH);
  ctx.restore();
}

function computeHeight(width: number, bounds: MapBounds, padding: number): number {
  const innerW = width - 2 * padding;
  const latSpan = bounds.maxLat - bounds.minLat;
  const lngSpan = bounds.maxLng - bounds.minLng;
  const aspect = lngSpan / latSpan;
  return Math.round(2 * padding + innerW / aspect);
}

async function getBoroughRender(
  borough: string,
  all: LocalityPayload["neighborhoods"],
  opts: ReturnType<typeof parseArgs>,
  cache: Map<string, BoroughRender>
): Promise<BoroughRender> {
  const existing = cache.get(borough);
  if (existing) return existing;

  const inBorough = all.filter((n) => n.borough === borough);
  const bbox = padBounds(boundsForNeighborhoods(inBorough), opts.boroughPadFraction);
  const innerW = opts.width - 2 * opts.paddingPx;

  const mercatorPlan =
    opts.useOsm && opts.height == null ? planMercatorViewport(bbox, innerW) : null;
  const height =
    opts.height ??
    (mercatorPlan
      ? Math.round(mercatorPlan.innerH) + 2 * opts.paddingPx
      : computeHeight(opts.width, bbox, opts.paddingPx));
  const innerH = height - 2 * opts.paddingPx;

  const baseCanvas = createCanvas(opts.width, height);
  const baseCtx = baseCanvas.getContext("2d");

  let project: Projector;

  if (opts.useOsm) {
    const tileMeta = TILE_SOURCES[opts.tileSource];
    console.error(`Map tiles: ${borough} (${opts.tileSource})…`);
    baseCtx.fillStyle = opts.background;
    baseCtx.fillRect(0, 0, opts.width, height);
    const fixedZ = mercatorPlan?.z;
    const merc = await drawOsmIntoRect(
      baseCtx,
      bbox,
      opts.paddingPx,
      opts.paddingPx,
      innerW,
      innerH,
      {
        cacheDir: opts.tileCacheDir,
        rateLimitMs: opts.osmRateLimitMs,
        cacheSlug: tileMeta.cacheSlug,
      },
      fixedZ
    );
    applyBasemapWash(
      baseCtx,
      opts.paddingPx,
      opts.paddingPx,
      innerW,
      innerH,
      opts.mapWashOpacity
    );
    project = makeMercatorProjector(
      merc.z,
      merc.minX,
      merc.minY,
      merc.worldW,
      merc.worldH,
      opts.paddingPx,
      opts.width,
      height
    );
  } else {
    baseCtx.fillStyle = opts.background;
    baseCtx.fillRect(0, 0, opts.width, height);
    project = makeProjector(bbox, opts.width, height, opts.paddingPx);
  }

  for (const n of inBorough) {
    drawPolygon(
      baseCtx,
      n.boundary.coordinates,
      project,
      opts.mutedFill,
      opts.mutedStroke,
      opts.useOsm ? opts.mutedLineWidth : 0.85
    );
  }

  if (opts.useOsm && opts.osmAttribution) {
    drawOsmAttribution(
      baseCtx,
      opts.width,
      height,
      TILE_SOURCES[opts.tileSource].attribution
    );
  }

  const br: BoroughRender = { height, project, baseCanvas };
  cache.set(borough, br);
  return br;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(opts.dataPath, "utf8");
  const payload = JSON.parse(raw) as LocalityPayload;
  const neighborhoods = payload.neighborhoods;

  const list = opts.maxCount != null ? neighborhoods.slice(0, opts.maxCount) : neighborhoods;

  fs.mkdirSync(opts.outputDir, { recursive: true });

  const boroughCache = new Map<string, BoroughRender>();

  let written = 0;
  for (let hi = 0; hi < list.length; hi++) {
    const focus = list[hi];
    const bSlug = slugPart(focus.borough);
    const nSlug = slugPart(focus.name);
    const dir = path.join(opts.outputDir, bSlug);
    const filePath = path.join(dir, `${nSlug}.webp`);

    if (opts.dryRun) {
      console.log(filePath);
      continue;
    }

    fs.mkdirSync(dir, { recursive: true });

    const br = await getBoroughRender(focus.borough, neighborhoods, opts, boroughCache);

    const canvas = createCanvas(opts.width, br.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(br.baseCanvas, 0, 0);

    drawPolygon(
      ctx,
      focus.boundary.coordinates,
      br.project,
      opts.highlightFill,
      opts.highlightStroke,
      opts.useOsm ? opts.highlightLineWidth : 2.25
    );

    const pngBuf = await canvas.encode("png");
    const webpBuf = await sharp(pngBuf)
      .webp({ quality: opts.webpQuality, effort: 6, smartSubsample: true })
      .toBuffer();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, webpBuf);
    written++;
    if (written % 25 === 0 || written === list.length) {
      console.error(`Wrote ${written}/${list.length}…`);
    }
  }

  if (!opts.dryRun) {
    console.error(`Done. ${written} WebP files in ${opts.outputDir}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
