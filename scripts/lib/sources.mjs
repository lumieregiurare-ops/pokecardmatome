// ポケカ関連ニュースの収集。各社の RSS（公式 YouTube チャンネルを含む）、Google ニュースの検索フィード、
// RSS の無い公式サイトのお知らせ一覧を読む。記事本文は持たず、見出し・要約の一部・リンクだけを扱う。
import { fetchText, cleanUrl, hostOf, log, truncate } from "./util.mjs";
import { parseFeed, stripTags, decodeEntities, firstImage } from "./xml.mjs";

// Google ニュースの見出しは「本文 - 媒体名」の形なので分ける
function splitGoogleTitle(title) {
  const m = title.match(/^(.*)\s[-–—]\s([^-–—]{2,30})$/);
  return m ? { title: m[1].trim(), source: m[2].trim() } : { title: title.trim(), source: "" };
}

export async function fetchFeed(feed) {
  const xml = await fetchText(feed.url, { timeoutMs: 20000 });
  return parseFeed(xml).map((e) => {
    const summary = stripTags(e.description || e.content || "");
    return {
      source: feed.name,
      sourceKind: feed.kind || "news",
      title: decodeEntities(e.title || "").trim(),
      url: cleanUrl(e.link || ""),
      summary: truncate(summary, 160),
      publishedAt: e.date ? new Date(e.date).toISOString() : null,
      image: e.media || firstImage(e.content || e.description || ""),
      tags: e.categories || [],
      // 公式チャンネルなど、ポケカ専門のフィードはキーワード判定を通さずそのまま載せる
      always: !!feed.always,
    };
  });
}

// Google ニュースはキーワード検索の結果を RSS で返す。媒体名が source 要素に入る
export async function fetchGoogleNews(query, { within = "2d", perQuery = 40 } = {}) {
  const q = encodeURIComponent(`${query} when:${within}`);
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`, { timeoutMs: 20000 });
  const blocks = xml.split(/<item>/).slice(1, perQuery + 1);
  const out = [];
  for (const b of blocks) {
    const rawTitle = decodeEntities((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").trim();
    const link = decodeEntities((b.match(/<link>([^<]*)<\/link>/) || [])[1] || "").trim();
    const date = (b.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1] || "";
    const srcName = decodeEntities((b.match(/<source url="[^"]*">([^<]*)<\/source>/) || [])[1] || "").trim();
    const srcUrl = (b.match(/<source url="([^"]*)"/) || [])[1] || "";
    if (!rawTitle || !link) continue;
    const t = splitGoogleTitle(rawTitle);
    out.push({
      source: srcName || t.source || "Google ニュース",
      sourceKind: "news",
      sourceHost: hostOf(srcUrl),
      title: t.title,
      url: link,
      summary: "",
      publishedAt: date ? new Date(date).toISOString() : null,
      image: "",
      tags: [],
      viaGoogle: true,
      query,
    });
  }
  return out;
}

// RSS の無いお知らせ一覧のページから、linkPattern に当たるリンクの見出しだけを拾う。
// 日付は URL（/info/2026/20261009_004321.html の 20261009）か、リンクの近くの「2026.10.09」から読む。
// ページの作りが変わったら 0 件になるだけで、エラーにはしない。
export async function fetchPageList(src) {
  const html = await fetchText(src.url, { timeoutMs: 20000 });
  const linkRe = new RegExp(src.linkPattern);
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!linkRe.test(m[1])) continue;
    let url;
    try {
      url = new URL(decodeEntities(m[1]), src.url).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    // リンクの中に日付やカテゴリ名が一緒に入っていることがあるので落とす
    const text = stripTags(m[2])
      .replace(/\b\d{4}[./年]\s?\d{1,2}[./月]\s?\d{1,2}日?(?:\s*[(（][^)）]{1,3}[)）])?/g, " ")
      .replace(/^(?:\s*(?:NEW|New|新着|お知らせ|商品|イベント|大会|キャンペーン|その他|重要)\s+)+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 6) continue;
    seen.add(url);
    let publishedAt = null;
    const d = url.match(/(20\d{2})(\d{2})(\d{2})_/) || m[0].match(/(20\d{2})[./年]\s?(\d{1,2})[./月]\s?(\d{1,2})/) || html.slice(Math.max(0, m.index - 300), m.index).match(/(20\d{2})[./年]\s?(\d{1,2})[./月]\s?(\d{1,2})(?!.*20\d{2}[./年])/s);
    if (d) publishedAt = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3], 1, 0, 0)).toISOString(); // 日本時間 10:00 として扱う
    out.push({
      source: src.name,
      sourceKind: src.kind || "news",
      title: truncate(text, 120),
      url: cleanUrl(url),
      summary: "",
      publishedAt,
      image: "",
      tags: [],
      always: !!src.always,
    });
    if (out.length >= (src.max || 30)) break;
  }
  return out;
}

export async function fetchAll(config) {
  const items = [];
  const stats = {};

  for (const feed of config.feeds || []) {
    try {
      const got = await fetchFeed(feed);
      items.push(...got);
      stats[feed.name] = (stats[feed.name] || 0) + got.length;
    } catch (e) {
      log(`feed failed ${feed.name}: ${e.message}`);
      stats[feed.name] = `error`;
    }
  }

  for (const src of config.pageLists || []) {
    try {
      const got = await fetchPageList(src);
      items.push(...got);
      stats[src.name] = got.length;
    } catch (e) {
      log(`page list failed ${src.name}: ${e.message}`);
      stats[src.name] = "error";
    }
  }

  const g = config.googleNews || {};
  if (g.enabled !== false) {
    let n = 0;
    for (const q of g.queries || []) {
      try {
        const got = await fetchGoogleNews(q, { within: g.within, perQuery: g.perQuery });
        items.push(...got);
        n += got.length;
      } catch (e) {
        log(`google news failed (${q}): ${e.message}`);
      }
    }
    stats["Google ニュース"] = n;
  }

  return { items, stats };
}
