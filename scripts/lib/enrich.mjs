// 画像が無い記事に、記事ページの og:image を補って回る。
// Google ニュース経由の記事は RSS に画像も元記事の URL も入っていないので、
// 記事ページに埋め込まれた署名付きリクエストを Google の内部 API に投げて実 URL を割り出してから
// その実 URL のページを取りに行く。Google 側の実装が変われば黙って失敗するだけで、
// その場合はプレースホルダーのまま表示される（サイト全体は壊れない）。
import { fetchText, hostOf } from "./util.mjs";
import { decodeEntities } from "./xml.mjs";

function ogImage(html) {
  const re = /<meta[^>]+(?:property|name)=["']og:image[^"']*["'][^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    if (c && /^https?:\/\//.test(c[1])) return decodeEntities(c[1]);
  }
  return "";
}

// 記事ページに埋め込まれている、実 URL 解決用の署名（id / タイムスタンプ / 署名）
function gnAttrs(html) {
  const idx = html.indexOf("data-n-a-id");
  if (idx === -1) return null;
  const chunk = html.slice(idx, idx + 400);
  const id = (chunk.match(/data-n-a-id="([^"]+)"/) || [])[1];
  const ts = (chunk.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  const sg = (chunk.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  return id && ts && sg ? { id, ts, sg } : null;
}

async function resolveGoogleNewsUrl(gnUrl, timeoutMs) {
  const html = await fetchText(gnUrl, { timeoutMs });
  const attrs = gnAttrs(html);
  if (!attrs) return "";
  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    attrs.id,
    Number(attrs.ts),
    attrs.sg,
  ]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]));
  const res = await fetchText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    timeoutMs,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  // レスポンスは JSON 文字列の中に JSON 文字列が入れ子になっているので、
  // エスケープされた引用符（\"）越しに URL を拾う
  const m = res.match(/garturlres\\?"\s*,\s*\\?"(https?:[^\\"]+)/);
  return m ? m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/") : "";
}

async function pool(list, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      await worker(list[idx]);
    }
  });
  await Promise.all(runners);
}

export async function enrichImages(items, { limit = 160, concurrency = 8, timeoutMs = 8000, budgetMs = 180000 } = {}) {
  const targets = items.filter((it) => !it.image && /^https?:\/\//.test(it.url)).slice(0, limit);
  if (!targets.length) return 0;
  const start = Date.now();
  let done = 0;
  await pool(targets, concurrency, async (it) => {
    if (Date.now() - start > budgetMs) return;
    try {
      let url = it.url;
      if (it.viaGoogle) {
        const real = await resolveGoogleNewsUrl(url, timeoutMs);
        if (!real) return;
        it.url = real;
        it.host = hostOf(real);
        it.viaGoogle = false;
        url = real;
      }
      const html = await fetchText(url, { timeoutMs });
      const img = ogImage(html);
      if (img) {
        it.image = img;
        done++;
      }
    } catch {
      /* だめならプレースホルダーのまま */
    }
  });
  return done;
}
