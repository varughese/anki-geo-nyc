/**
 * Parses https://locality.nyc/application.js — neighborhood polygons live in
 * repeated `neighborhoods = neighborhoods.concat([...])` arrays.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractBracketArray(js, openBracketIndex) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = openBracketIndex; i < js.length; i++) {
    const c = js[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return js.slice(openBracketIndex, i + 1);
    }
  }
  throw new Error("Unbalanced [ ] while extracting neighborhood array");
}

function extractBoroughsObject(js) {
  const marker = "var boroughs = ";
  const i = js.indexOf(marker);
  if (i === -1) return null;
  let start = i + marker.length;
  if (js[start] !== "{") throw new Error("boroughs parse: expected {");
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let j = start; j < js.length; j++) {
    const c = js[j];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const objSrc = js.slice(start, j + 1);
        return new Function(`return (${objSrc})`)();
      }
    }
  }
  throw new Error("Unbalanced { } in boroughs");
}

function main() {
  const jsPath = process.argv[2] || path.join(__dirname, "..", "vendor", "locality-application.js");
  const outPath = process.argv[3] || path.join(__dirname, "..", "data", "locality-nyc-neighborhoods.json");

  const src = fs.readFileSync(jsPath, "utf8");
  const marker = "neighborhoods = neighborhoods.concat([";
  const chunks = [];
  let pos = 0;
  while (true) {
    const idx = src.indexOf(marker, pos);
    if (idx === -1) break;
    const openBracket = idx + marker.length - 1;
    const arrLiteral = extractBracketArray(src, openBracket);
    const parsed = new Function(`return (${arrLiteral})`)();
    chunks.push(parsed);
    pos = idx + marker.length;
  }

  const flat = chunks.flat();
  const boroughs = extractBoroughsObject(src);

  const payload = {
    meta: {
      source: "https://locality.nyc/",
      applicationJs: "https://locality.nyc/application.js",
      extractedAt: new Date().toISOString(),
      neighborhoodCount: flat.length,
      note: "Site content attributes neighborhood names, boundaries, and summaries to MusikAnimal and nyc.gov / OSM / Wikipedia / Google Maps contributors. Summaries and boundary definitions may be copyrighted; see locality.nyc About/Attribution before redistributing commercially.",
      mapViewportBounds: {
        southWest: { lat: 40.3518381, lng: -74.351592 },
        northEast: { lat: 40.9071533, lng: -73.7153225 },
      },
    },
    boroughCenters: boroughs,
    neighborhoods: flat.map((n) => {
      const ring = n.coords.map((c) => [c.lng, c.lat]);
      const closed =
        ring.length > 0 &&
        (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
          ? [...ring, ring[0]]
          : ring;
      return {
        name: n.name,
        borough: n.borough,
        strokeOrFillColorHex: n.color != null ? `#${n.color}` : undefined,
        labelCenter: n.center,
        boundary: {
          type: "Polygon",
          coordinates: [closed],
        },
        summaryHtml: n.summary ?? null,
      };
    }),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.error(`Wrote ${flat.length} neighborhoods to ${outPath}`);
}

main();
