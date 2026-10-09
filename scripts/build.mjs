// site/（編集用ソース）→ docs/（公開用）へビルドする。
// JS と CSS は esbuild で圧縮し、HTML はコメントと余分な空白を落とす。
// docs/data/ は収集スクリプトが書く JSON なので触らない。
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import sharp from "sharp";
import { minifyHtml, renderPages } from "./lib/pages.mjs";

// カードのサムネイル枠は 382x200 程度なので、その 2 倍を上限に縮小する
const IMAGE_MAX_WIDTH = 800;
const IMAGE_QUALITY = 82;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "site");
const OUT = join(ROOT, "docs");
const banner = `/* ポケカ速報 — built ${new Date().toISOString().slice(0, 10)} */`;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// トップの HTML と sitemap.xml は記事を差し込んで pages.mjs が書くので、ここでは写さない
const RENDERED = new Set(["index.html", "sitemap.xml"]);

let count = 0;
for (const file of await walk(SRC)) {
  const rel = relative(SRC, file);
  if (RENDERED.has(rel)) continue;
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  const ext = extname(file).toLowerCase();

  // 画像は表示サイズに合わせて縮小・再圧縮する（元ファイルは site/ にそのまま残す）
  if (ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    const buf = await readFile(file);
    const meta = await sharp(buf).metadata();
    let img = sharp(buf).rotate();
    if ((meta.width || 0) > IMAGE_MAX_WIDTH) img = img.resize({ width: IMAGE_MAX_WIDTH });
    const data = ext === ".png" ? await img.png({ compressionLevel: 9 }).toBuffer() : await img.jpeg({ quality: IMAGE_QUALITY, mozjpeg: true }).toBuffer();
    await writeFile(dest, data);
    count++;
    console.log(`${rel.padEnd(28)} ${String(buf.length).padStart(7)} → ${String(data.length).padStart(7)} B (${Math.round((data.length / buf.length) * 100)}%)`);
    continue;
  }

  const src = await readFile(file, "utf8");
  let out = src;
  if (ext === ".js") {
    // 圧縮 + 変数名の短縮。文字列（日本語の表示文言）はそのまま残る
    const r = await transform(src, { minify: true, target: "es2019", legalComments: "none" });
    out = `${banner}\n${r.code}`;
  } else if (ext === ".css") {
    const r = await transform(src, { loader: "css", minify: true, legalComments: "none" });
    out = `${banner}\n${r.code}`;
  } else if (ext === ".html") {
    out = minifyHtml(src);
  }
  await writeFile(dest, out, "utf8");
  count++;
  const before = Buffer.byteLength(src);
  const after = Buffer.byteLength(out);
  console.log(`${rel.padEnd(28)} ${String(before).padStart(7)} → ${String(after).padStart(7)} B (${Math.round((after / before) * 100)}%)`);
}
console.log(`built ${count} files → docs/`);

// CSS・JS を書いたあとに作る（ページに付ける ?v= がそれらの中身から決まるため）
await renderPages(ROOT, { log: console.log });
