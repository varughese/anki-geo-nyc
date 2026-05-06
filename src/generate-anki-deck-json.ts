import fs from "node:fs/promises";
import path from "node:path";

type LocalityNeighborhood = {
  name: string;
  borough: string;
  summaryHtml?: string | null;
};

type LocalityPayload = {
  neighborhoods: LocalityNeighborhood[];
};

type DeckCard = {
  id: string;
  neighborhood: string;
  borough: string;
  summaryHtml: string | null;
  summaryText: string | null;
  imageRelativePath: string | null;
};

type DeckPayload = {
  meta: {
    generatedAt: string;
    totalCards: number;
    cardsWithImages: number;
    cardsMissingImages: number;
    imageRoot: string;
    imagePrefix: string;
    sourceDataPath: string;
  };
  cards: DeckCard[];
};

function slugPart(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const decoded = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<sup>(.*?)<\/sup>/gi, "^$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const stripped = decoded.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return stripped.length ? stripped : null;
}

function parseArgs(argv: string[]) {
  const out = {
    dataPath: path.resolve("data/locality-nyc-neighborhoods.json"),
    imagesRoot: path.resolve("output/neighborhood-maps-webp"),
    imagePrefix: "neighborhood-maps-webp",
    outputPath: path.resolve("output/anki/neighborhood-deck.json"),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data" && argv[i + 1]) out.dataPath = path.resolve(argv[++i]);
    else if (a === "--images-root" && argv[i + 1]) out.imagesRoot = path.resolve(argv[++i]);
    else if (a === "--image-prefix" && argv[i + 1]) out.imagePrefix = argv[++i];
    else if (a === "--out" && argv[i + 1]) out.outputPath = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: pnpm generate:deck-json [options]

Creates Anki-ready JSON with summary fields and relative image paths.

Options:
  --data <path>         Source locality JSON (default: ./data/locality-nyc-neighborhoods.json)
  --images-root <dir>   Where generated images live (default: ./output/neighborhood-maps-webp)
  --image-prefix <dir>  Prefix used in imageRelativePath (default: neighborhood-maps-webp)
  --out <path>          Output JSON path (default: ./output/anki/neighborhood-deck.json)
`);
      process.exit(0);
    }
  }

  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(opts.dataPath, "utf8");
  const payload = JSON.parse(raw) as LocalityPayload;

  const cards: DeckCard[] = [];
  let cardsWithImages = 0;

  for (const n of payload.neighborhoods) {
    const boroughSlug = slugPart(n.borough);
    const neighborhoodSlug = slugPart(n.name);
    const relative = `${opts.imagePrefix}/${boroughSlug}/${neighborhoodSlug}.webp`;
    const absolute = path.join(opts.imagesRoot, boroughSlug, `${neighborhoodSlug}.webp`);

    let imageRelativePath: string | null = null;
    try {
      await fs.access(absolute);
      imageRelativePath = relative;
      cardsWithImages++;
    } catch {
      imageRelativePath = null;
    }

    cards.push({
      id: `${boroughSlug}__${neighborhoodSlug}`,
      neighborhood: n.name,
      borough: n.borough,
      summaryHtml: n.summaryHtml ?? null,
      summaryText: htmlToText(n.summaryHtml ?? null),
      imageRelativePath,
    });
  }

  const output: DeckPayload = {
    meta: {
      generatedAt: new Date().toISOString(),
      totalCards: cards.length,
      cardsWithImages,
      cardsMissingImages: cards.length - cardsWithImages,
      imageRoot: opts.imagesRoot,
      imagePrefix: opts.imagePrefix,
      sourceDataPath: opts.dataPath,
    },
    cards,
  };

  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  await fs.writeFile(opts.outputPath, JSON.stringify(output, null, 2), "utf8");
  console.error(`Wrote ${output.meta.totalCards} cards to ${opts.outputPath}`);
  console.error(
    `Images: ${output.meta.cardsWithImages} present, ${output.meta.cardsMissingImages} missing`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
