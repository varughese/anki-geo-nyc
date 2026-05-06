import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

interface Options {
  inputDir: string;
  dryRun: boolean;
  minSavingsBytes: number;
}

function parseArgs(argv: string[]): Options {
  const out: Options = {
    inputDir: path.resolve("output/neighborhood-maps"),
    dryRun: false,
    minSavingsBytes: 256,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) out.inputDir = path.resolve(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--min-savings" && argv[i + 1]) {
      out.minSavingsBytes = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: pnpm optimize:images [options]

Recompresses PNG maps in-place with palette quantization and high compression.

Options:
  --input <dir>         Root directory to process (default: ./output/neighborhood-maps)
  --dry-run             Report savings only, do not write files
  --min-savings <bytes> Skip rewrites smaller than this amount (default: 256)
`);
      process.exit(0);
    }
  }
  return out;
}

async function listPngFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full.toLowerCase().endsWith(".png")) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function optimizePng(filePath: string): Promise<{
  before: number;
  after: number;
  changed: boolean;
}> {
  const input = await fs.readFile(filePath);
  const before = input.byteLength;
  const optimized = await sharp(input)
    .png({
      compressionLevel: 9,
      effort: 10,
      adaptiveFiltering: true,
      palette: true,
      quality: 80,
      dither: 1,
    })
    .toBuffer();
  const after = optimized.byteLength;
  return { before, after, changed: after < before };
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const files = await listPngFiles(opts.inputDir);
  if (files.length === 0) {
    throw new Error(`No PNG files found in ${opts.inputDir}`);
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let rewrites = 0;

  for (const file of files) {
    const input = await fs.readFile(file);
    const before = input.byteLength;
    totalBefore += before;

    const optimized = await sharp(input)
      .png({
        compressionLevel: 9,
        effort: 10,
        adaptiveFiltering: true,
        palette: true,
        quality: 80,
        dither: 1,
      })
      .toBuffer();
    const after = optimized.byteLength;

    if (before - after >= opts.minSavingsBytes) {
      if (!opts.dryRun) {
        await fs.writeFile(file, optimized);
      }
      totalAfter += after;
      rewrites++;
    } else {
      totalAfter += before;
    }
  }

  const saved = totalBefore - totalAfter;
  const pct = totalBefore > 0 ? ((saved / totalBefore) * 100).toFixed(2) : "0.00";
  console.error(`Files scanned: ${files.length}`);
  console.error(`Files rewritten: ${rewrites}${opts.dryRun ? " (dry-run)" : ""}`);
  console.error(`Before: ${formatBytes(totalBefore)}`);
  console.error(`After:  ${formatBytes(totalAfter)}`);
  console.error(`Saved:  ${formatBytes(saved)} (${pct}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
