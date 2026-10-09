// ポケカ関連のニュースを集めて docs/data/news.json を作る。
// 記事本文は保存せず、見出し・要約の一部・元記事へのリンクだけを持つ。
// あわせて、見出しから「抽選・予約の受付」と「これからの予定（発売日・締切など）」を読み取って載せる。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson, writeJson, idOf, hostOf, log, truncate } from "./lib/util.mjs";
import { fetchAll } from "./lib/sources.mjs";
import { enrichImages } from "./lib/enrich.mjs";
import { buildTopics } from "./lib/cluster.mjs";
import { updateArchive, loadArchive } from "./lib/archive.mjs";
import { renderPages } from "./lib/pages.mjs";
import { classify } from "./lib/classify.mjs";
import { updateProducts, buildBoards } from "./lib/boards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data", "news.json");
const RUN = join(ROOT, "data", "last-run.json");
const STATE = join(ROOT, "data", "state.json");
const PRODUCTS = join(ROOT, "data", "products.json");
const ARCHIVE = join(ROOT, "data", "archive");

const started = Date.now();
const config = await readJson(join(ROOT, "config.json"));
const now = new Date();
const nowIso = now.toISOString();

const WATCHDOG_MIN = config.watchdogMinutes ?? 15;
setTimeout(() => {
  console.error(`[watchdog] ${WATCHDOG_MIN} 分を超えたため中断します`);
  process.exit(2);
}, WATCHDOG_MIN * 60 * 1000).unref();

const C = classify(config);

// 重複判定用に見出しを正規化する（全角英数を半角に、空白と末尾の媒体名を落とす）
function normTitle(t) {
  return t
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（(][^（()）]{2,12}[)）]\s*$/, "")
    .replace(/\s*[|｜]\s*[^|｜]{2,20}$/, "")
    .replace(/[\s　]+/g, "")
    .toLowerCase()
    .slice(0, 40);
}

// 要約が見出しの繰り返しになっている媒体があるので、その場合は要約を出さない
function cleanSummary(title, summary) {
  let s = summary || "";
  const bare = (x) => x.replace(/[\s　]+/g, "").slice(0, 40);
  if (s && bare(s).startsWith(bare(title))) {
    s = s.replace(/[\s　]+/g, " ").slice(title.length).replace(/^[\s　:：|｜ー-]+/, "");
  }
  if (bare(s) === bare(title) || s.length < 12) return "";
  return truncate(s, 160);
}

// ---------- 1. 収集 ----------
// COLLECT_FIXTURE に JSON（fetchAll が返す形の記事の配列）を渡すと、ネットワークを使わずにそれを読む。
// 外へつながらない環境で、絞り込み・抽選ボード・ページ生成を確かめるためのもの
const FIXTURE = process.env.COLLECT_FIXTURE;
const { items: raw, stats: sourceStats } = FIXTURE ? { items: await readJson(FIXTURE, []), stats: { fixture: "on" } } : await fetchAll(config);
log(`fetched ${raw.length} items${FIXTURE ? `（${FIXTURE} から）` : ""}`);

// ---------- 2. 絞り込み・整形・重複除去 ----------
const maxAge = (config.maxArticleAgeDays ?? 7) * 86400000;
const byId = new Map();
const dropped = { offTopic: 0, notJa: 0, tooOld: 0, dup: 0, noTitle: 0, blocked: 0, capped: 0 };
// ひらがな・カタカナ・漢字のいずれかを含むか（日本語の見出しかの判定）
const JA_RE = /[぀-ゟ゠-ヿ一-鿿]/;

for (const r of raw) {
  if (!r.title || !/^https?:\/\//.test(r.url || "")) {
    dropped.noTitle++;
    continue;
  }
  if (r.publishedAt && now.getTime() - new Date(r.publishedAt).getTime() > maxAge) {
    dropped.tooOld++;
    continue;
  }
  // 画像ギャラリー・ショップの商品ページ・SNS の投稿は載せない
  const host = r.sourceHost || hostOf(r.url);
  if (C.isBlocked(r.title, r.source, host)) {
    dropped.blocked++;
    continue;
  }
  // 日本語の記事を中心にするので、見出しに日本語が含まれないものは載せない
  if (!r.always && !JA_RE.test(r.title)) {
    dropped.notJa++;
    continue;
  }
  const text = `${r.title} ${r.summary || ""}`;
  // 総合ゲームメディア・プレスリリースのフィードも読んでいるので、ポケカに関係する記事だけを残す
  if (!r.always && !C.isTopic(text)) {
    dropped.offTopic++;
    continue;
  }

  // 同じ記事が元フィードと Google ニュースの両方から来るので、見出しで重複を判定する
  // （Google 経由は URL が毎回変わるため URL では突き合わせできない）
  const id = idOf(`t:${normTitle(r.title)}`);
  const prev = byId.get(id);
  const isPR = C.isPR(r.source);
  const isOfficial = r.sourceKind === "official" || C.isOfficialHost(host) || C.isOfficialHost(hostOf(r.url));

  if (prev) {
    dropped.dup++;
    // 元サイトの直リンクが手に入ったら、Google 経由のリンクより優先する
    if (prev.viaGoogle && !r.viaGoogle) {
      prev.url = r.url;
      prev.viaGoogle = false;
      prev.host = hostOf(r.url);
      prev.source = r.source;
      prev.isPR = isPR;
    }
    if (!prev.summary) prev.summary = cleanSummary(r.title, r.summary);
    if (!prev.image && r.image) prev.image = r.image;
    if (isOfficial) prev.isOfficial = true;
    continue;
  }

  byId.set(id, {
    id,
    title: truncate(r.title, 120),
    url: r.url,
    host,
    source: r.source,
    summary: cleanSummary(r.title, r.summary),
    publishedAt: r.publishedAt || nowIso,
    image: r.image || "",
    categories: C.categorize(text),
    series: C.detectSeries(text),
    // ショップのブログ（ホビーステーション・カードラボ）は、媒体名そのものが店の名前
    stores: C.detectStores(`${text} ${r.source} ${host}`),
    products: [],
    isOfficial,
    isPR,
    viaGoogle: !!r.viaGoogle,
  });
}

let items = [...byId.values()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

// 同じ媒体・同じ型の見出しばかりにならないよう、新しいものから決まった数だけ残す
{
  const before = items.length;
  items = C.applyCaps(items);
  dropped.capped = before - items.length;
}
log(`kept ${items.length} (対象外 ${dropped.offTopic} / 古い ${dropped.tooOld} / 除外 ${dropped.blocked} / 重複 ${dropped.dup} / 件数制限 ${dropped.capped})`);

// ---------- 2.5 画像の補完 ----------
// Google ニュース経由の記事は RSS に画像も元記事の URL も入っていないので、
// 記事ページから実 URL を割り出して og:image を取りに行く（失敗しても無視する）
if (!FIXTURE) try {
  const enriched = await enrichImages(items);
  log(`images enriched: ${enriched}`);
} catch (e) {
  log("画像の補完に失敗:", e.message);
}

// ---------- 2.8 商品名 ----------
// 見出しの「拡張パック「〇〇」」から商品名を覚えていき（data/products.json）、
// 覚えた名前が出てくる記事にその商品を付ける
const productDb = await readJson(PRODUCTS, { products: [] });
const productNames = updateProducts(productDb, items, config.productAliases || {}, nowIso);
await writeJson(PRODUCTS, productDb);
log(`products: ${productNames.length} known`);

// ---------- 3. 同じ話題をまとめる ----------
let topics = [];
if (config.cluster?.enabled !== false) {
  topics = buildTopics(items, config.cluster, config.entities || []);
  log(`topics: ${topics.length}（最大 ${topics[0]?.sourceCount || 0} 媒体）`);
}

// ---------- 3.5 前回の収集と比べて、新着を見分ける ----------
const prev = (await readJson(STATE, { ranAt: "", ids: [] })) || { ranAt: "", ids: [] };
const prevIds = new Set(prev.ids || []);
for (const it of items) it.isNew = prevIds.size > 0 && !prevIds.has(it.id);
const churn = {
  previousAt: prev.ranAt || "",
  previousCount: prevIds.size,
  newCount: items.filter((i) => i.isNew).length,
};
// 次の更新の目安は、cron の設定値ではなく「実際に走った間隔の中央値」から出す。
// GitHub Actions のスケジュール実行は遅れたり飛んだりするため、設定どおりの時刻を書くと
// カウントダウンが 0 のまま何時間も止まり、更新が終わったように見えてしまう。
const RECENT_GAPS = 6;
const runs = [...(prev.runs || []), nowIso].slice(-24);
function medianGapMin(runList) {
  const ts = runList.map((t) => new Date(t).getTime()).filter((n) => n > 0);
  ts.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 60000);
  if (!gaps.length) return null;
  const recent = gaps.slice(-RECENT_GAPS).sort((a, b) => a - b);
  return Math.round(recent[Math.floor((recent.length - 1) / 2)]);
}
const updateGapMin = medianGapMin(runs);
const nextUpdateAt = updateGapMin ? new Date(now.getTime() + updateGapMin * 60000).toISOString() : "";

// ---------- 4. 過去の記事を貯め、抽選ボードと予定表を作る ----------
// 抽選の締切や発売日は、7 日より前の記事に書かれていることも多いので、貯めた記事からも拾う
let boards = { lottery: [], schedule: [], products: [], stores: [] };
try {
  const n = await updateArchive(ARCHIVE, items);
  log(`archive: ${n} day files updated`);
  const archive = await loadArchive(ARCHIVE);
  boards = buildBoards({ items, archive, config, productDb, now });
  log(`lottery board: ${boards.lottery.length} / schedule: ${boards.schedule.length}`);
} catch (e) {
  log("抽選ボード・予定表の作成に失敗:", e.stack || e.message);
}

// ---------- 5. 保存 ----------
const catCounts = {};
for (const it of items) for (const c of it.categories) catCounts[c] = (catCounts[c] || 0) + 1;
const seriesCounts = {};
for (const it of items) for (const s of it.series || []) seriesCounts[s] = (seriesCounts[s] || 0) + 1;
const sourceCounts = {};
for (const it of items) sourceCounts[it.source] = (sourceCounts[it.source] || 0) + 1;

const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
await writeJson(OUT, {
  updatedAt: nowIso,
  site: config.site || {},
  total: items.length,
  todayCount: items.filter((i) => new Date(new Date(i.publishedAt).getTime() + 9 * 3600000).toISOString().slice(0, 10) === today).length,
  categories: [...C.categories.map((c) => ({ id: c.id, label: c.label })), C.fallback].map((c) => ({ ...c, count: catCounts[c.id] || 0 })),
  series: C.series.map((s) => ({ id: s.id, label: s.label, count: seriesCounts[s.id] || 0 })),
  stores: boards.stores,
  products: boards.products,
  sources: Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count })),
  topics,
  lottery: boards.lottery,
  schedule: boards.schedule,
  churn,
  updateGapMin,
  nextUpdateAt,
  items: items.map(({ viaGoogle, ...it }) => it),
});

await writeJson(STATE, { ranAt: nowIso, runs, ids: items.map((i) => i.id) });

// ---------- 6. 検索エンジン向けのページを作り直す ----------
// ここで失敗しても news.json はもう書けているので、収集そのものは成功として終える
try {
  await renderPages(ROOT, { log });
} catch (e) {
  log("ページの生成に失敗:", e.stack || e.message);
}

const summary = {
  ranAt: nowIso,
  durationSec: Math.round((Date.now() - started) / 1000),
  fetched: raw.length,
  kept: items.length,
  topics: topics.length,
  lottery: boards.lottery.length,
  schedule: boards.schedule.length,
  dropped,
  sources: sourceStats,
};
await writeJson(RUN, summary);
log(`done in ${summary.durationSec}s: ${items.length} articles, ${topics.length} topics`);
