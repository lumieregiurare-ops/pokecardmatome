// 載せた記事を日ごと（日本時間）のファイルに貯めておく。news.json は 7 日で消えるが、
// こちらは残るので、種別・商品別・店舗別のページや日別のページを作る材料になる。
// 1 日 1 ファイルにしているのは、収集のたびに書き換わるのをその日前後のファイルだけにするため
// （月ごとの大きなファイルにすると、30 分おきのコミットでリポジトリがどんどん膨らむ）。
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// 商品名（products）は辞書（data/products.json）が育つと変わるので、ここには持たず、使うときに見出しから読む
const FIELDS = ["id", "title", "url", "source", "summary", "publishedAt", "image", "categories", "series", "stores", "isOfficial", "isPR"];

export function jstDay(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

function fileOf(dir, day) {
  const [y, m, d] = day.split("-");
  return join(dir, y, m, `${d}.json`);
}

function pick(it) {
  const o = {};
  for (const k of FIELDS) if (it[k] !== undefined) o[k] = it[k];
  return o;
}

async function readDay(dir, day) {
  try {
    return JSON.parse(await readFile(fileOf(dir, day), "utf8"));
  } catch {
    return [];
  }
}

// いまの記事を日ごとのファイルへ足し込む。中身が変わったファイルだけ書き直す
export async function updateArchive(dir, items) {
  const byDay = new Map();
  for (const it of items) {
    const day = jstDay(it.publishedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(it);
  }
  let written = 0;
  for (const [day, list] of byDay) {
    const prev = await readDay(dir, day);
    const map = new Map(prev.map((it) => [it.id, it]));
    for (const it of list) {
      const old = map.get(it.id);
      const next = pick(it);
      // 画像や要約は後から取れることがあるので、取れていた値は空で上書きしない
      if (old) {
        if (!next.image && old.image) next.image = old.image;
        if (!next.summary && old.summary) next.summary = old.summary;
      }
      map.set(it.id, next);
    }
    const merged = [...map.values()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
    const out = JSON.stringify(merged, null, 1);
    if (out === JSON.stringify(prev, null, 1)) continue;
    const f = fileOf(dir, day);
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, out, "utf8");
    written++;
  }
  return written;
}

// すべての日を読む。返り値は [{ day: "2026-09-24", items: [...] }]（新しい日から）
export async function loadArchive(dir) {
  const days = [];
  let years = [];
  try {
    years = await readdir(dir);
  } catch {
    return days;
  }
  for (const y of years.filter((x) => /^\d{4}$/.test(x))) {
    for (const m of (await readdir(join(dir, y))).filter((x) => /^\d{2}$/.test(x))) {
      for (const f of (await readdir(join(dir, y, m))).filter((x) => /^\d{2}\.json$/.test(x))) {
        const day = `${y}-${m}-${f.slice(0, 2)}`;
        const items = await readDay(dir, day);
        if (items.length) days.push({ day, items });
      }
    }
  }
  return days.sort((a, b) => (a.day < b.day ? 1 : -1));
}
