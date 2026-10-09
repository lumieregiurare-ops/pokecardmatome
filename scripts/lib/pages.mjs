// 検索エンジン向けの静的ページを docs/ に書き出す。収集（collect.mjs）とビルド（build.mjs）の最後に呼ぶ。
// トップの画面は app.js が news.json を読んで描くが、それだけだと検索エンジンからは中身が
// 「読み込み中…」にしか見えないので、抽選ボード・予定・記事の一覧を HTML にも書いておく（app.js が描き直す）。
// あわせて、抽選・予約、これからの予定、ゲーム別・種別・商品別・店舗別・日別の過去ニュースのページと、
// sitemap.xml・feed.xml を作る。Node の標準機能だけで動く（GitHub Actions の収集で npm ci しないため）。
//
// ヘッダーとフッターは site/index.html から切り出して使うので、見た目を変えるときは index.html を直せばよい。
// ページの文言は config.json の pages に書く（series / genres）。
// pokematome の pages.mjs を元に、商品・店舗・抽選・予定のページを足したもの。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { loadArchive, jstDay } from "./archive.mjs";
import { productMatcher, buildBoards } from "./boards.mjs";
import { lotteryStatus, productSlug, ymd, jstMidnight } from "./extract.mjs";

export function minifyHtml(html) {
  return html
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, "") // 条件付きコメント以外のコメントを除去
    .replace(/>\s+</g, "><") // タグ間の空白
    .replace(/\s{2,}/g, " ")
    .trim();
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const WD_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
// 種別・商品・店舗のページに載せる件数と、さかのぼる日数
const LIST_MAX = 60;
const LIST_DAYS = 180;
// これより記事が少ないページは noindex にして sitemap にも載せない（中身の薄いページを検索に出さない）
const MIN_INDEXABLE = 3;
const CAT_CODE = { lottery: "LOTTERY", restock: "RESTOCK", release: "RELEASE", reveal: "CARDS", event: "EVENT", promo: "PROMO", market: "MARKET", deck: "DECK", caution: "ALERT", goods: "GOODS", other: "NEWS" };
const STATUS = { today: "本日締切", open: "受付中", soon: "受付前", info: "情報", closed: "締切" };

// ---------- 小物 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
function jst(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600000);
}
const pad = (n) => String(n).padStart(2, "0");
function hhmm(iso) {
  const d = jst(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function dayParts(day) {
  const [y, m, d] = day.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, wd: WD[w], wdEn: WD_EN[w] };
}
const md = (day) => {
  const p = dayParts(day);
  return `${p.m}/${p.d}`;
};
const mdw = (day) => {
  const p = dayParts(day);
  return `${p.m}/${p.d}（${p.wd}）`;
};
const jpDay = (day) => {
  const p = dayParts(day);
  return `${p.y}年${p.m}月${p.d}日（${p.wd}）`;
};
const dayPath = (day) => day.replace(/-/g, "/");
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function ld(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}
async function readText(p) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}
async function readJsonOr(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}
// 改行コードをそろえてから計算する（Windows で git が CRLF に変えたファイルでも、Actions と同じ値になるように）
async function verOf(p) {
  const t = (await readText(p)).replace(/\r\n/g, "\n");
  return t ? createHash("sha1").update(t).digest("hex").slice(0, 8) : "0";
}

// ---------- 本体 ----------
export async function renderPages(root, { log = () => {}, now = new Date() } = {}) {
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  const P = config.pages || {};
  const DOCS = join(root, "docs");
  const SITE = config.site?.title || "";
  const BASE = (config.site?.url || "/").replace(/\/?$/, "/");
  const abs = (path) => BASE + path.replace(/^\//, "");
  const nowMs = now.getTime();
  const today = ymd(jstMidnight(nowMs));
  const year = Number(today.slice(0, 4));

  const news = await readJsonOr(join(DOCS, "data", "news.json"), null);
  const archive = await loadArchive(join(root, "data", "archive"));
  const productDb = await readJsonOr(join(root, "data", "products.json"), { products: [] });
  const indexTpl = await readText(join(root, "site", "index.html"));
  if (!indexTpl) return [];
  const ver = {
    css: await verOf(join(DOCS, "assets", "app.css")),
    app: await verOf(join(DOCS, "assets", "app.js")),
  };

  // ---------- データの下ごしらえ ----------
  const catLabel = (id) => (config.categories || []).find((c) => c.id === id)?.label || "";
  const stores = config.stores || [];
  const storeLabel = (id) => stores.find((s) => s.id === id)?.label || id;
  const genres = (config.categories || []).filter((c) => P.genres?.[c.id]).map((c) => ({ ...c, ...P.genres[c.id] }));
  const genrePath = (g) => g.path || `/news/${g.slug}/`;
  const seriesPages = (config.series || []).filter((s) => P.series?.[s.id]).map((s) => ({ ...s, ...P.series[s.id] }));
  const matchProducts = productMatcher(productDb, config.productAliases);
  const slugOf = new Map((productDb.products || []).map((p) => [p.name, p.slug]));
  const prodUrl = (name) => `/set/${slugOf.get(name) || productSlug(name)}/`;

  const seen = new Set();
  const all = [];
  for (const d of archive)
    for (const it of d.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      all.push({ ...it, products: matchProducts(it.title) });
    }
  all.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const recent = all.filter((it) => nowMs - new Date(it.publishedAt).getTime() <= LIST_DAYS * 86400000);

  // 抽選ボードと予定は news.json のものを使う（無ければ貯めた記事から作る）
  const boards = news?.lottery ? { lottery: news.lottery, schedule: news.schedule || [] } : buildBoards({ items: [], archive, config, productDb, now });
  const lotteryAll = boards.lottery.map((e) => ({ ...e, _st: e.ended ? "closed" : lotteryStatus(e, today) }));
  const lotteryActive = lotteryAll.filter((e) => e._st !== "closed");
  const schedule = boards.schedule.filter((e) => e.day >= today);

  // 商品別・店舗別のページの材料
  const products = new Map();
  for (const it of recent)
    for (const name of it.products) {
      if (!products.has(name)) products.set(name, { name, url: prodUrl(name), items: [] });
      products.get(name).items.push(it);
    }
  const releaseOf = new Map((news?.products || []).map((p) => [p.name, p.release]));
  const productList = [...products.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, "ja"));
  const storePages = stores.map((s) => ({ ...s, url: `/store/${s.id}/`, items: recent.filter((it) => (it.stores || []).includes(s.id)) }));

  // ---------- テンプレート（site/index.html）からヘッダー・フッターを切り出す ----------
  const siteLinks = [
    ["/lottery/", "抽選・予約"],
    ["/schedule/", "発売カレンダー"],
    ["/set/", "商品別"],
    ["/store/", "店舗別"],
    ...seriesPages.filter((s) => s.id !== config.defaultSeries).map((s) => [`/${s.slug}/`, s.label]),
    ...genres.filter((g) => g.id !== "lottery").map((g) => [genrePath(g), g.label]),
    ["/archive/", "過去ログ"],
  ];
  const navLinks = (current = "") => siteLinks.map(([h, t]) => `<a href="${h}"${h === current ? ' aria-current="page"' : ""}>${esc(t)}</a>`).join("");
  function footerLinks() {
    return `<nav class="footer-nav" aria-label="サイト内のページ">
      <a href="/">トップ</a><a href="/lottery/">抽選・予約</a><a href="/schedule/">発売カレンダー</a><a href="/set/">商品別</a><a href="/store/">店舗別</a>
      ${seriesPages.map((s) => `<a href="/${s.slug}/">${esc(s.label)}</a>`).join("")}
      ${genres.filter((g) => g.id !== "lottery").map((g) => `<a href="${genrePath(g)}">${esc(g.label)}</a>`).join("")}
      <a href="/archive/">過去ログ</a><a href="/about/">このサイトについて</a><a href="/feed.xml">RSS</a>
    </nav>${
      (config.sisterSites || []).length
        ? `<nav class="footer-nav footer-sisters" aria-label="運営サイト"><span class="footer-nav-label">SISTER SITES</span>${config.sisterSites
            .map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>`)
            .join("")}</nav>`
        : ""
    }`;
  }
  const sources = (news?.sources || []).map((s) => s.name);
  // 入れ子の div ごと 1 つの要素を取り除く（正規表現だと最初の </div> で切れてしまうため）
  function dropElement(html, openTag) {
    const start = html.indexOf(openTag);
    if (start < 0) return html;
    const re = /<\/?div\b[^>]*>/g;
    re.lastIndex = start;
    let depth = 0;
    for (let m; (m = re.exec(html)); ) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return html.slice(0, start) + html.slice(re.lastIndex);
    }
    return html;
  }
  // ティッカーとあとで読むは app.js が無いと動かないので、サブページでは外す
  const tplHeader = dropElement((indexTpl.match(/<header class="header">[\s\S]*?<\/header>/) || [""])[0], '<div class="ticker"');
  const tplFooter = (indexTpl.match(/<footer class="footer">[\s\S]*?<\/footer>/) || [""])[0];
  const headerHtml = (current) =>
    tplHeader
      .replace(/<h1 class="logo">([\s\S]*?)<\/h1>/, '<div class="logo">$1</div>')
      .replace('href="./"', 'href="/"')
      .replace('href="#favorites"', 'href="/#favorites"')
      .replace(/<nav class="global-nav"[\s\S]*?<\/nav>/, `<nav class="global-nav" aria-label="サイト内のページ"><div class="wrap nav-inner"><a href="/">トップ</a>${navLinks(current)}</div></nav>`)
      .replace(/<a class="tool-btn fav-link"[\s\S]*?<\/a>/, "")
      .replace(/ id="(?!q")[^"]*"/g, "");
  const footerHtml = tplFooter
    .replace(/<!--ssr:footer-links-->/, footerLinks())
    .replace('<span id="year"></span>', String(year))
    .replace(/<p class="sources">[\s\S]*?<\/p>/, '<p class="sources">収集元は<a href="/about/">このサイトについて</a>に載せています。</p>')
    .replace(/ id="[^"]*"/g, "");
  const notice = ((tplFooter.match(/<p class="notice">([\s\S]*?)<\/p>/) || [])[1] || "").trim();
  // charset・viewport・明暗の切り替え（<title> より前にあるもの）
  const headStatic = ((indexTpl.match(/<head>([\s\S]*?)<title>/) || [])[1] || "").replace("<!--ssr:ga-->", gaTag(config.site?.gaId));
  const fontHref = (indexTpl.match(/href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/) || [])[1] || "";
  const fontLinks = fontHref
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preload" as="style" href="${fontHref}" onload="this.onload=null;this.rel='stylesheet'"><noscript><link rel="stylesheet" href="${fontHref}"></noscript>`
    : "";
  const verify = P.googleSiteVerification ? `<meta name="google-site-verification" content="${esc(P.googleSiteVerification)}">` : "";
  const themeColor = P.themeColor || "#0d0e10";
  // サブページには app.js を読ませないので、明暗の切り替えだけをここで動かす
  const themeScript = `<script>(function(){var b=document.querySelector(".header .tool-btn[aria-label*='切り替え']");if(!b)return;b.addEventListener("click",function(){var r=document.documentElement,n=r.getAttribute("data-theme")==="light"?"dark":"light";r.setAttribute("data-theme",n);try{localStorage.setItem("pkc:theme",n)}catch(e){}})})();</script>`;

  const written = [];
  const sitemap = [];
  async function out(path, html, { lastmod, index = true } = {}) {
    const file = path.endsWith("/") ? join(DOCS, path, "index.html") : join(DOCS, path);
    const text = path.endsWith(".xml") ? html : minifyHtml(html);
    if ((await readText(file)).replace(/\r\n/g, "\n") !== text) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, "utf8");
      written.push(path);
    }
    if (index) sitemap.push({ loc: abs(path), lastmod });
  }

  // サイドバーは全ページに入るので、収集のたびに変わる値（件数・並び順）は入れない。
  // 入れると、記事が増えない過去の日別ページまで毎回書き換わり、FTP で送る量とリポジトリが膨らみ続ける
  const sideProducts = productList
    .filter((p) => p.items.length >= MIN_INDEXABLE)
    .slice(0, 10)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  function sideHtml() {
    const block = (en, title, list) =>
      list.length ? `<section class="mod"><h2 class="mod-head"><span class="en">${en}</span>${esc(title)}</h2><ul class="side-links">${list.join("")}</ul></section>` : "";
    return `<aside class="side">
      ${block("BOARD", "抽選・予定", ['<li><a href="/lottery/">抽選・予約の受付</a></li>', '<li><a href="/schedule/">発売・締切のカレンダー</a></li>'])}
      ${block("PRODUCTS", "商品別", [...sideProducts.map((p) => `<li><a href="${p.url}">${esc(p.name)}</a></li>`), '<li><a href="/set/">すべての商品</a></li>'])}
      ${block("GAMES", "ゲーム別", seriesPages.map((s) => `<li><a href="/${s.slug}/">${esc(s.label)}</a></li>`))}
      ${block("GENRES", "ニュースの種別", genres.map((g) => `<li><a href="${genrePath(g)}">${esc(g.label)}</a></li>`))}
      ${block("MORE", "ほかのページ", ['<li><a href="/">トップ（新着・話題）</a></li>', '<li><a href="/store/">店舗別</a></li>', '<li><a href="/archive/">過去ログ</a></li>', '<li><a href="/about/">このサイトについて</a></li>'])}
    </aside>`;
  }

  function page({ path, title, desc, h1, en = "", lead = "", facts = "", body, crumbs = [], jsonld = [], noindex = false, nav = "" }) {
    const fullTitle = `${title}｜${SITE}`;
    const trail = [{ name: SITE, path: "/" }, ...crumbs];
    const bc = crumbs.length
      ? {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: trail.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: abs(c.path) })),
        }
      : null;
    return `<!doctype html>
<html lang="ja" data-theme="dark">
<head>${headStatic}
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(desc)}">
  ${noindex ? '<meta name="robots" content="noindex, follow">' : ""}
  ${verify}
  <meta name="theme-color" content="${themeColor}">
  ${path === "/404.html" ? "" : `<link rel="canonical" href="${abs(path)}">`}
  <meta property="og:site_name" content="${esc(SITE)}">
  <meta property="og:title" content="${esc(fullTitle)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${abs(path)}">
  <meta property="og:image" content="${abs("/assets/og.png")}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="ja_JP">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(fullTitle)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${abs("/assets/og.png")}">
  <link rel="alternate" type="application/atom+xml" title="${esc(SITE)}" href="/feed.xml">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ${bc ? ld(bc) : ""}
  ${jsonld.map(ld).join("")}
  ${fontLinks}
  <link rel="stylesheet" href="/assets/app.css?v=${ver.css}">
</head>
<body>
  ${headerHtml(nav || path)}
  <main class="wrap">
    ${
      crumbs.length
        ? `<nav class="crumbs" aria-label="パンくずリスト"><ol>${trail
            .map((c, i) => (i === trail.length - 1 ? `<li aria-current="page">${esc(c.name)}</li>` : `<li><a href="${c.path}">${esc(c.name)}</a></li>`))
            .join("")}</ol></nav>`
        : ""
    }
    <div class="layout layout-page">
      <div class="col-main">
        <div class="page-intro">
          <h1 class="sec-title page-title">${en ? `<span class="en">${esc(en)}</span>` : ""}${esc(h1)}</h1>
          ${lead ? `<p class="page-lead">${lead}</p>` : ""}
          ${facts}
        </div>
        ${body}
      </div>
      ${sideHtml()}
    </div>
  </main>
  ${footerHtml}
  ${themeScript}
</body>
</html>`;
  }

  // ---------- 部品: ニュースの行（app.js の row と同じ形） ----------
  function thumb(it, cls = "row-thumb") {
    const href = esc(safeUrl(it.url));
    if (it.image && /^https?:\/\//.test(it.image))
      return `<a class="${cls}" href="${href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('thumb-ph');this.parentNode.textContent='${CAT_CODE[(it.categories || [])[0]] || "NEWS"}'"></a>`;
    return `<a class="${cls} thumb-ph" href="${href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${CAT_CODE[(it.categories || [])[0]] || "NEWS"}</a>`;
  }
  function rowHtml(it) {
    const top = [];
    if (it.isOfficial) top.push('<span class="badge badge-official">公式</span>');
    for (const c of (it.categories || []).slice(0, 2)) if (c !== "other" && catLabel(c)) top.push(`<span class="k k-${c}">${esc(catLabel(c))}</span>`);
    top.push(`<span class="row-src">${esc(it.source)}</span><time datetime="${esc(it.publishedAt)}">${hhmm(it.publishedAt)}</time>`);
    if (it.isPR) top.push('<span class="badge badge-pr">PR</span>');
    const tags = [
      ...(it.stores || []).map((s) => `<a class="tag-store" href="/store/${esc(s)}/">${esc(storeLabel(s))}</a>`),
      ...(it.products || []).slice(0, 3).map((p) => `<a class="tag-prod" href="${prodUrl(p)}">${esc(p)}</a>`),
    ];
    return `<article class="row">${thumb(it)}<div class="row-body">
      <div class="row-top">${top.join("")}</div>
      <h3 class="row-title"><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
      ${it.summary ? `<p class="row-sum">${esc(it.summary)}</p>` : ""}
      ${tags.length ? `<div class="row-tags">${tags.join("")}</div>` : ""}
    </div></article>`;
  }
  function grouped(items, tag = "h2") {
    const groups = new Map();
    for (const it of items) {
      const k = jstDay(it.publishedAt);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    let html = "";
    for (const [day, list] of groups) {
      const p = dayParts(day);
      html += `<section class="day"><${tag} class="day-head">${p.m}.${p.d}<small>${p.wdEn}</small><span class="n">${list.length} 件</span></${tag}><div class="rows">${list.map(rowHtml).join("")}</div></section>`;
    }
    return html;
  }

  // ---------- 部品: 抽選ボードの行（app.js の lotRow と同じ形） ----------
  function lotRowHtml(e) {
    const st = e._st;
    const target = st === "soon" ? e.deadline || e.start : e.deadline;
    let when = '<span class="none">締切は記事で確認</span>';
    if (target) {
      const left = dayDiff(target, today);
      let leftText = "締切済み";
      if (st === "soon") leftText = e.deadline ? `${md(e.start)} から受付` : "受付開始";
      else if (left === 0) leftText = e.deadlineTime ? `本日 ${e.deadlineTime} まで` : "本日まで";
      else if (left > 0) leftText = `あと ${left} 日${e.deadlineTime ? ` ${e.deadlineTime}` : ""}`;
      when = `<span class="d">${md(target)}</span><span class="wd">(${dayParts(target).wd})</span><span class="left${left <= 1 && left >= 0 && st !== "soon" ? " hot" : ""}">${leftText}</span>`;
    }
    const tags = [
      ...(e.stores || []).map((s) => `<a class="tag-store" href="/store/${esc(s)}/">${esc(storeLabel(s))}</a>`),
      ...(e.products || []).slice(0, 2).map((p) => `<a class="tag-prod" href="${prodUrl(p)}">${esc(p)}</a>`),
    ];
    if (!tags.length || e.method !== "情報") tags.push(`<span class="tag-method">${esc(e.method)}</span>`);
    return `<div class="lot-row is-${st}"><span class="st st-${st}">${STATUS[st]}</span><div class="lot-when">${when}</div><div class="lot-tags">${tags.join("")}</div>
      <div class="lot-body"><a class="lot-title" href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">${esc(e.title)}</a>
      <span class="lot-meta">${e.isOfficial ? '<span class="off">公式</span>' : ""}${esc(e.source)} ・ ${md(jstDay(e.publishedAt))} ${hhmm(e.publishedAt)} 掲載${e.count > 1 ? ` ・ ${e.count} 媒体` : ""}</span></div></div>`;
  }
  function boardHtml(list, { head = true, empty = "いま受付中の抽選・予約の情報はありません。" } = {}) {
    if (!list.length) return `<p class="board-empty">${esc(empty)}</p>`;
    return `${head ? '<div class="lot-head" aria-hidden="true"><span>状況</span><span>締切</span><span>店舗・商品</span><span>内容</span></div>' : ""}<div class="lot-list">${list.map(lotRowHtml).join("")}</div>`;
  }

  // ---------- 部品: カレンダー（app.js の renderCalendar と同じ形） ----------
  function calHtml(list, { maxItems = 12, perDay = 4 } = {}) {
    if (!list.length) return '<p class="mod-desc">いまは日付のわかる予定がありません。</p>';
    const days = new Map();
    for (const e of list) {
      if (!days.has(e.day)) days.set(e.day, []);
      days.get(e.day).push(e);
    }
    let html = "";
    let n = 0;
    for (const [day, items] of days) {
      if (n >= maxItems) break;
      const left = dayDiff(day, today);
      const its = items
        .slice(0, perDay)
        .map((e) => {
          n++;
          const sub = [e.products?.length ? e.products.join(" / ") : "", e.time ? `${e.time}〜` : ""].filter(Boolean).join(" ・ ");
          return `<a class="cal-item" href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener"><span class="a a-${esc(e.act)}">${esc(e.actLabel)}</span><span class="t">${esc(e.title)}</span>${sub ? `<span class="p">${esc(sub)}</span>` : ""}</a>`;
        })
        .join("");
      html += `<div class="cal-day${left <= 3 ? " is-soon" : ""}${left === 0 ? " is-today" : ""}"><div class="cal-date"><span class="md">${md(day)}</span><span class="wd">${dayParts(day).wd}</span><span class="left">${left === 0 ? "TODAY" : `あと${left}日`}</span></div><div class="cal-items">${its}</div></div>`;
    }
    return html;
  }

  function itemList(items, name) {
    return {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name,
      numberOfItems: Math.min(items.length, 20),
      itemListElement: items.slice(0, 20).map((it, i) => ({ "@type": "ListItem", position: i + 1, url: it.url, name: it.title })),
    };
  }
  const lastOf = (items) => items.reduce((a, it) => (it.publishedAt > a ? it.publishedAt : a), "") || undefined;
  const factsHtml = (pairs) => `<dl class="page-facts">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

  // ---------- トップ ----------
  {
    const items = news?.items || [];
    const listHtml = items.length
      ? grouped(items.slice(0, 30), "h3")
      : '<div class="loading"><span class="spinner" role="status" aria-label="読み込み中"></span><span>ニュースを読み込んでいます…</span></div>';
    let meta = "読み込み中…";
    if (news) {
      const u = jst(news.updatedAt);
      meta = `${news.total} 本 ・ 今日 ${news.todayCount} 本 ・ 最終更新 ${u.getUTCMonth() + 1}/${u.getUTCDate()} ${hhmm(news.updatedAt)}`;
    }
    const head = [
      verify,
      `<link rel="alternate" type="application/atom+xml" title="${esc(SITE)}" href="feed.xml">`,
      ld({ "@context": "https://schema.org", "@type": "Organization", name: SITE, url: BASE, logo: abs("/apple-touch-icon.png") }),
      items.length ? ld(itemList(items, `${SITE}の新着ニュース`)) : "",
    ].join("");
    const html = indexTpl
      .replace("<!--ssr:ga-->", gaTag(config.site?.gaId))
      .replace("<!--ssr:head-->", head)
      .replace("<!--ssr:nav-->", navLinks())
      .replace("<!--ssr:lottery-->", lotteryActive.slice(0, 10).map(lotRowHtml).join("") || '<p class="board-empty">いま受付中の抽選・予約の情報はありません。</p>')
      .replace("<!--ssr:calendar-->", calHtml(schedule))
      .replace("<!--ssr:list-->", listHtml)
      .replace("<!--ssr:footer-links-->", footerLinks())
      .replace('<span id="meta">読み込み中…</span>', `<span id="meta">${esc(meta)}</span>`)
      .replace(/href="assets\/app\.css"/, `href="assets/app.css?v=${ver.css}"`)
      .replace(/src="assets\/app\.js"/, `src="assets/app.js?v=${ver.app}"`);
    await out("/", html, { lastmod: news?.updatedAt });
  }

  // ---------- 抽選・予約 ----------
  {
    const g = genres.find((x) => x.id === "lottery");
    const items = recent.filter((it) => (it.categories || []).includes("lottery")).slice(0, LIST_MAX);
    const open = lotteryAll.filter((e) => e._st === "open" || e._st === "today").length;
    const path = "/lottery/";
    await out(
      path,
      page({
        path,
        en: "LOTTERY BOARD",
        title: "ポケカの抽選・予約情報（受付中の一覧）",
        desc: g?.desc || "ポケモンカードの抽選販売・予約受付の情報をまとめています。",
        h1: "ポケカの抽選・予約の受付",
        lead: `${esc(g?.desc || "")}締切は見出しから読み取ったものです。受付の条件や正確な日時は、必ずリンク先で確かめてください。`,
        facts: factsHtml([
          ["受付中", `${open}`],
          ["掲載中", `${lotteryAll.length}`],
          ["更新", news ? `${md(jstDay(news.updatedAt))} ${hhmm(news.updatedAt)}` : "-"],
        ]),
        body: `<section class="board board-page">${boardHtml(lotteryAll)}</section>
          ${items.length ? `<section class="page-sec"><h2 class="sec-title"><span class="en">NEWS</span>抽選・予約のニュース</h2>${grouped(items, "h3")}</section>` : ""}`,
        crumbs: [{ name: "抽選・予約", path }],
        jsonld: lotteryAll.length ? [itemList(lotteryAll, "ポケカの抽選・予約情報")] : [],
      }),
      { lastmod: news?.updatedAt }
    );
  }

  // ---------- これからの予定 ----------
  {
    const path = "/schedule/";
    const months = new Map();
    for (const e of schedule) {
      const k = e.day.slice(0, 7);
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(e);
    }
    let body = "";
    for (const [k, list] of months) {
      const [y, m] = k.split("-").map(Number);
      body += `<section class="page-sec"><h2 class="sec-title"><span class="en">${y}.${pad(m)}</span>${y}年${m}月</h2><div class="cal cal-page">${calHtml(list, { maxItems: 999, perDay: 99 })}</div></section>`;
    }
    await out(
      path,
      page({
        path,
        en: "CALENDAR",
        title: "ポケカの発売日・抽選締切カレンダー",
        desc: "ポケモンカードの新弾・新商品の発売日、再販・入荷日、抽選・予約の締切、大会・イベントの開催日を、ニュースの見出しから拾って日付順に並べています。",
        h1: "これからの予定（発売日・締切・開催日）",
        lead: `ニュースの見出しにあった「10月17日発売」「10/12まで受付」のような日付を、きょうから ${120} 日先まで日付順に並べています。見出しから機械的に読み取ったものなので、必ずリンク先で確かめてください。`,
        body: body || '<p class="empty">いまは日付のわかる予定がありません。</p>',
        crumbs: [{ name: "これからの予定", path }],
        jsonld: schedule.length ? [itemList(schedule, "ポケカのこれからの予定")] : [],
      }),
      { lastmod: news?.updatedAt }
    );
  }

  // ---------- 商品別 ----------
  for (const p of productList) {
    const items = p.items.slice(0, LIST_MAX);
    const path = p.url;
    const lot = lotteryAll.filter((e) => (e.products || []).includes(p.name));
    const sch = schedule.filter((e) => (e.products || []).includes(p.name));
    const rel = releaseOf.get(p.name);
    const facts = factsHtml([
      ["発売日（記事から）", rel ? `${jpDay(rel).replace(/^\d+年/, "")}` : "—"],
      ["受付中の抽選", `${lot.filter((e) => e._st === "open" || e._st === "today").length}`],
      ["ニュース", `${p.items.length}`],
    ]);
    let body = "";
    if (lot.length) body += `<section class="page-sec"><h2 class="sec-title"><span class="en">LOTTERY</span>抽選・予約</h2><section class="board board-page">${boardHtml(lot)}</section></section>`;
    if (sch.length) body += `<section class="page-sec"><h2 class="sec-title"><span class="en">CALENDAR</span>予定</h2><div class="cal cal-page">${calHtml(sch, { maxItems: 30, perDay: 10 })}</div></section>`;
    body += `<section class="page-sec"><h2 class="sec-title"><span class="en">NEWS</span>ニュース</h2>${grouped(items, "h3")}</section>`;
    await out(
      path,
      page({
        path,
        en: "PRODUCT",
        title: `${p.name}の抽選・予約・再販情報`,
        desc: truncate(`ポケカ「${p.name}」の抽選・予約・再販・発売日のニュースをまとめています。${items.slice(0, 2).map((it) => it.title).join(" / ")}`, 120),
        h1: `${p.name}`,
        lead: `見出しに「${esc(p.name)}」が出てくるニュースを、新しいものから ${items.length} 件載せています（直近 ${LIST_DAYS} 日）。`,
        facts,
        body,
        crumbs: [
          { name: "商品別", path: "/set/" },
          { name: p.name, path },
        ],
        jsonld: [itemList(items, `${p.name}のニュース`)],
        noindex: p.items.length < MIN_INDEXABLE,
        nav: "/set/",
      }),
      { lastmod: lastOf(items), index: p.items.length >= MIN_INDEXABLE }
    );
  }
  await out(
    "/set/",
    page({
      path: "/set/",
      en: "PRODUCTS",
      title: "ポケカの商品別ニュース（拡張パック・スペシャルセットなど）",
      desc: "ポケモンカードの拡張パック・強化拡張パック・スペシャルセットなど、商品ごとに抽選・予約・再販・発売日のニュースをまとめています。",
      h1: "商品別のニュース",
      lead: `見出しの「拡張パック「〇〇」」などから商品名を自動で覚えて、商品ごとにニュースをまとめています（直近 ${LIST_DAYS} 日）。`,
      body: productList.length
        ? `<ul class="name-list">${productList
            .map((p) => `<li><a href="${p.url}">${esc(p.name)}<span class="n">${releaseOf.get(p.name) ? `${md(releaseOf.get(p.name))}発売 ・ ` : ""}${p.items.length} 件</span></a></li>`)
            .join("")}</ul>`
        : '<p class="empty">まだありません。</p>',
      crumbs: [{ name: "商品別", path: "/set/" }],
    }),
    { lastmod: news?.updatedAt }
  );

  // ---------- 店舗別 ----------
  for (const s of storePages) {
    const items = s.items.slice(0, LIST_MAX);
    const lot = lotteryAll.filter((e) => (e.stores || []).includes(s.id));
    const open = lot.filter((e) => e._st === "open" || e._st === "today").length;
    let body = `<section class="page-sec"><h2 class="sec-title"><span class="en">LOTTERY</span>抽選・予約</h2><section class="board board-page">${boardHtml(lot, { empty: `いま掲載中の${s.label}の抽選・予約の情報はありません。` })}</section></section>`;
    body += items.length ? `<section class="page-sec"><h2 class="sec-title"><span class="en">NEWS</span>ニュース</h2>${grouped(items, "h3")}</section>` : "";
    await out(
      s.url,
      page({
        path: s.url,
        en: "STORE",
        title: `${s.label}のポケカ抽選・予約・入荷情報`,
        desc: `${s.label}でのポケモンカードの抽選販売・予約受付・入荷のニュースをまとめています。`,
        h1: `${s.label}のポケカ抽選・予約情報`,
        lead: `見出し・要約に「${esc(s.label)}」が出てくるニュースをまとめています（直近 ${LIST_DAYS} 日）。受付の条件は店舗ごとに違うので、必ずリンク先で確かめてください。`,
        facts: factsHtml([
          ["受付中", `${open}`],
          ["ニュース", `${s.items.length}`],
        ]),
        body,
        crumbs: [
          { name: "店舗別", path: "/store/" },
          { name: s.label, path: s.url },
        ],
        jsonld: items.length ? [itemList(items, `${s.label}のポケカ抽選・予約情報`)] : [],
        noindex: s.items.length < MIN_INDEXABLE,
        nav: "/store/",
      }),
      { lastmod: lastOf(items), index: s.items.length >= MIN_INDEXABLE }
    );
  }
  await out(
    "/store/",
    page({
      path: "/store/",
      en: "STORES",
      title: "店舗別のポケカ抽選・予約情報",
      desc: "ポケモンセンター・家電量販店・コンビニ・カードショップなど、店舗ごとにポケモンカードの抽選・予約・入荷のニュースをまとめています。",
      h1: "店舗別の抽選・予約情報",
      lead: "店の名前が見出し・要約に出てくるニュースを、店ごとにまとめています。",
      body: `<ul class="name-list">${storePages
        .slice()
        .sort((a, b) => b.items.length - a.items.length)
        .map((s) => `<li><a href="${s.url}">${esc(s.label)}<span class="n">${s.items.length} 件</span></a></li>`)
        .join("")}</ul>`,
      crumbs: [{ name: "店舗別", path: "/store/" }],
    }),
    { lastmod: news?.updatedAt }
  );

  // ---------- ゲーム別 ----------
  for (const s of seriesPages) {
    const items = recent.filter((it) => (it.series || []).includes(s.id)).slice(0, LIST_MAX);
    const path = `/${s.slug}/`;
    await out(
      path,
      page({
        path,
        en: s.slug.toUpperCase(),
        title: `${s.title}（最新まとめ）`,
        desc: s.desc,
        h1: s.title,
        lead: `${esc(s.desc)}新しいものから ${items.length} 件を載せています。`,
        body: items.length ? grouped(items) : '<p class="empty">いまはこのゲームのニュースがありません。</p>',
        crumbs: [{ name: s.label, path }],
        jsonld: items.length ? [itemList(items, s.title)] : [],
        noindex: items.length < MIN_INDEXABLE,
      }),
      { lastmod: lastOf(items), index: items.length >= MIN_INDEXABLE }
    );
  }

  // ---------- ニュースの種別（抽選・予約は /lottery/ で作る） ----------
  for (const g of genres.filter((x) => x.id !== "lottery")) {
    const items = recent.filter((it) => (it.categories || []).includes(g.id)).slice(0, LIST_MAX);
    const path = genrePath(g);
    await out(
      path,
      page({
        path,
        en: g.slug.toUpperCase(),
        title: `${g.title}（最新まとめ）`,
        desc: g.desc,
        h1: g.title,
        lead: `${esc(g.desc)}新しいものから ${items.length} 件を載せています。`,
        body: items.length ? grouped(items) : '<p class="empty">いまはこの種別のニュースがありません。</p>',
        crumbs: [{ name: g.label, path }],
        jsonld: items.length ? [itemList(items, g.title)] : [],
        noindex: items.length < MIN_INDEXABLE,
      }),
      { lastmod: lastOf(items), index: items.length >= MIN_INDEXABLE }
    );
  }

  // ---------- 過去ログ（日別・月別） ----------
  const archiveDays = archive.map((d) => ({ day: d.day, items: d.items.map((it) => ({ ...it, products: matchProducts(it.title) })) }));
  const months = new Map();
  for (const d of archiveDays) {
    const k = d.day.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(d);
  }
  for (let i = 0; i < archiveDays.length; i++) {
    const d = archiveDays[i];
    const p = dayParts(d.day);
    const newer = archiveDays[i - 1];
    const older = archiveDays[i + 1];
    const path = `/archive/${dayPath(d.day)}/`;
    const pager = `<nav class="pager" aria-label="前後の日">
      ${older ? `<a href="/archive/${dayPath(older.day)}/">← ${mdw(older.day)}</a>` : "<span></span>"}
      <a href="/archive/${p.y}/${pad(p.m)}/">${p.y}年${p.m}月の一覧</a>
      ${newer ? `<a href="/archive/${dayPath(newer.day)}/">${mdw(newer.day)} →</a>` : "<span></span>"}
    </nav>`;
    await out(
      path,
      page({
        path,
        en: `${p.y}.${pad(p.m)}.${pad(p.d)}`,
        title: `${jpDay(d.day)}の${P.topic}ニュース ${d.items.length} 件`,
        desc: truncate(`${p.y}年${p.m}月${p.d}日の${P.topic}関連ニュース ${d.items.length} 件。${d.items.slice(0, 3).map((it) => it.title).join(" / ")}`, 120),
        h1: `${jpDay(d.day)}の${P.topic}ニュース`,
        lead: `この日に出た${esc(P.topic)}関連のニュース ${d.items.length} 件です。`,
        body: `<div class="rows">${d.items.map(rowHtml).join("")}</div>${pager}`,
        crumbs: [
          { name: "過去ログ", path: "/archive/" },
          { name: `${p.y}年${p.m}月`, path: `/archive/${p.y}/${pad(p.m)}/` },
          { name: `${p.d}日`, path },
        ],
        jsonld: [itemList(d.items, `${jpDay(d.day)}の${P.topic}ニュース`)],
        nav: "/archive/",
      }),
      { lastmod: lastOf(d.items) }
    );
  }
  for (const [k, days] of months) {
    const [y, m] = k.split("-").map(Number);
    const total = days.reduce((a, d) => a + d.items.length, 0);
    const path = `/archive/${y}/${pad(m)}/`;
    await out(
      path,
      page({
        path,
        en: `${y}.${pad(m)}`,
        title: `${y}年${m}月の${P.topic}ニュース一覧`,
        desc: `${y}年${m}月に出た${P.topic}関連のニュース ${total} 件を、日ごとにまとめています。`,
        h1: `${y}年${m}月の${P.topic}ニュース`,
        lead: `この月のニュース ${total} 件を日ごとに分けています。`,
        body: `<ul class="archive-days">${days
          .map(
            (d) => `<li><a class="archive-day" href="/archive/${dayPath(d.day)}/">${mdw(d.day)}<span class="n">${d.items.length} 件</span></a>
            <ul>${d.items
              .slice(0, 3)
              .map((it) => `<li>${esc(truncate(it.title, 60))}</li>`)
              .join("")}</ul></li>`
          )
          .join("")}</ul>`,
        crumbs: [
          { name: "過去ログ", path: "/archive/" },
          { name: `${y}年${m}月`, path },
        ],
        nav: "/archive/",
      }),
      { lastmod: lastOf(days.flatMap((d) => d.items)) }
    );
  }
  await out(
    "/archive/",
    page({
      path: "/archive/",
      en: "ARCHIVE",
      title: `過去の${P.topic}ニュース`,
      desc: `これまでに集めた${P.topic}関連のニュースを、月ごと・日ごとに見られます。`,
      h1: "過去ログ",
      lead: "これまでに集めたニュースを月ごとにまとめています。",
      body: months.size
        ? `<ul class="archive-days">${[...months]
            .map(([k, days]) => {
              const [y, m] = k.split("-").map(Number);
              return `<li><a class="archive-day" href="/archive/${y}/${pad(m)}/">${y}年${m}月<span class="n">${days.reduce((a, d) => a + d.items.length, 0)} 件</span></a></li>`;
            })
            .join("")}</ul>`
        : '<p class="empty">まだありません。</p>',
      crumbs: [{ name: "過去ログ", path: "/archive/" }],
    }),
    { lastmod: archiveDays[0] ? lastOf(archiveDays[0].items) : undefined }
  );

  // ---------- このサイトについて ----------
  await out(
    "/about/",
    page({
      path: "/about/",
      en: "ABOUT",
      title: "このサイトについて",
      desc: `${SITE}は、${P.topic}関連のニュースをあちこちの媒体から集めてまとめている、ファンによる非公式のまとめサイトです。`,
      h1: "このサイトについて",
      body: `<div class="prose">
        <h2>どんなサイト？</h2>
        <p>${esc(SITE)}は、ポケモンカード（ポケカ・ポケポケ）のニュースを、公式のお知らせ・ゲームメディア・ホビー媒体・ショップのお知らせ・プレスリリースなどから集めて、一か所で見られるようにしているまとめサイトです。30 分おきに自動で更新しています。</p>
        <h2>抽選ボードと予定について</h2>
        <p>「抽選・予約の受付」と「これからの予定」は、ニュースの見出しにある「10月12日まで」「10/17発売」のような日付と、店の名前・商品名を機械的に読み取って並べたものです。読み取りをまちがえることもあり、受付の条件や時刻は店ごとにちがいます。応募や購入の前に、必ずリンク先の記事や各店舗の公式のお知らせで確かめてください。</p>
        <h2>載せているもの</h2>
        <p>載せているのは、記事の見出し・要約の一部・元記事へのリンクと、元記事が設定している紹介用の画像だけです。記事の本文は転載していません。くわしい内容はリンク先の元記事でご覧ください。記事と画像の権利は、それぞれの発行元に帰属します。種別・商品・店舗の分け方は見出しのことばから機械的に判定しているので、まちがっていることもあります。</p>
        ${notice ? `<h2>非公式のサイトです</h2><p>${notice}</p>` : ""}
        <h2>ブラウザに保存しているもの</h2>
        <p>「あとで読む」に入れた記事・見たくないことば・画面の状態・明るさの設定は、お使いのブラウザ（localStorage）にだけ保存しています。サーバーには送っていません。</p>
        ${sources.length ? `<h2>おもな収集元</h2><p>${sources.slice(0, 40).map(esc).join(" / ")}</p>` : ""}
        ${config.site?.contactUrl ? `<h2>お問い合わせ</h2><p><a href="${esc(config.site.contactUrl)}" target="_blank" rel="noopener">お問い合わせフォーム</a></p>` : ""}
      </div>`,
      crumbs: [{ name: "このサイトについて", path: "/about/" }],
    })
  );

  // ---------- 404 ----------
  await out(
    "/404.html",
    page({
      path: "/404.html",
      en: "404",
      title: "ページが見つかりません",
      desc: "お探しのページは見つかりませんでした。",
      h1: "ページが見つかりません",
      lead: "お探しのページは、移動したか、なくなった可能性があります。",
      body: '<p><a class="more-btn" href="/">トップへ戻る</a></p>',
      noindex: true,
    }),
    { index: false }
  );

  // ---------- feed.xml（Atom） ----------
  {
    const items = (news?.items || []).slice(0, 50);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ja">
  <title>${esc(SITE)}</title>
  <subtitle>${esc(config.site?.tagline || "")}</subtitle>
  <link href="${BASE}" rel="alternate"/>
  <link href="${abs("/feed.xml")}" rel="self"/>
  <id>${BASE}</id>
  <updated>${news?.updatedAt || now.toISOString()}</updated>
  <author><name>${esc(SITE)}</name></author>
${items
  .map(
    (it) => `  <entry>
    <title>${esc(it.title)}</title>
    <link href="${esc(safeUrl(it.url))}"/>
    <id>${BASE}#${it.id}</id>
    <updated>${new Date(it.publishedAt).toISOString()}</updated>
    <summary>${esc(`${it.source}${it.summary ? ` ／ ${it.summary}` : ""}`)}</summary>
  </entry>`
  )
  .join("\n")}
</feed>
`;
    await out("/feed.xml", xml, { index: false });
  }

  // ---------- sitemap.xml ----------
  {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap
  .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().replace(/\.\d{3}Z$/, "+00:00")}</lastmod>` : ""}</url>`)
  .join("\n")}
</urlset>
`;
    await out("/sitemap.xml", xml, { index: false });
  }

  log(`pages: ${sitemap.length} indexable, ${written.length} written`);
  return written;
}

// Google アナリティクス（config.json の site.gaId が空なら何も入れない）
function gaTag(id) {
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return "";
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`;
}
