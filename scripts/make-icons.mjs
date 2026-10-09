// site/favicon.svg から PNG のアイコンを作る（普段は不要。アイコンの絵を変えたときだけ流す）。
// OGP 画像は scripts/make-og.py で作る。
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const svg = await readFile(join(SITE, "favicon.svg"));
for (const [name, size] of [
  ["favicon-48.png", 48],
  ["apple-touch-icon.png", 180],
]) {
  await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(join(SITE, name));
  console.log(`wrote site/${name}`);
}
