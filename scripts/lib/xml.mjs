// 依存なしの簡易 RSS / Atom パーサ（今回の収集元で必要な範囲のみ）

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#160": " " };

export function decodeEntities(s) {
  if (!s) return "";
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return m;
  });
}

export function stripCdata(s) {
  return s ? s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") : "";
}

export function stripTags(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(stripCdata(m[1])).trim() : "";
}

function tags(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gi");
  return [...block.matchAll(re)].map((m) => decodeEntities(stripCdata(m[1])).trim());
}

function attr(block, tagName, attrName, filterAttr) {
  const re = new RegExp(`<${tagName}\\b([^>]*)\\/?>`, "gi");
  for (const m of block.matchAll(re)) {
    const attrs = m[1];
    if (filterAttr && !new RegExp(`${filterAttr.name}=["']${filterAttr.value}["']`, "i").test(attrs)) continue;
    const a = attrs.match(new RegExp(`${attrName}=["']([^"']+)["']`, "i"));
    if (a) return decodeEntities(a[1]);
  }
  return "";
}

export function parseFeed(xml) {
  if (/<feed[\s>]/i.test(xml.slice(0, 2000))) return parseAtom(xml);
  return parseRss(xml);
}

function parseAtom(xml) {
  const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
  return entries.map((e) => ({
    id: tag(e, "id"),
    title: tag(e, "title"),
    link: attr(e, "link", "href", { name: "rel", value: "alternate" }) || attr(e, "link", "href"),
    date: tag(e, "published") || tag(e, "updated"),
    // YouTube の動画フィードは説明文が media:description に入っている
    content: tag(e, "content") || tag(e, "summary") || tag(e, "media:description"),
    categories: [...e.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1])),
    media: mediaImage(e),
  }));
}

function parseRss(xml) {
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  return items.map((it) => ({
    id: tag(it, "guid") || tag(it, "link"),
    title: tag(it, "title"),
    link: tag(it, "link"),
    date: tag(it, "pubDate") || tag(it, "dc:date"),
    content: tag(it, "content:encoded") || tag(it, "description"),
    description: tag(it, "description"),
    categories: tags(it, "category"),
    media: mediaImage(it),
  }));
}

export function firstImage(html) {
  const m = (html || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : "";
}

// media:content / media:thumbnail / enclosure (画像のときだけ) からサムネイル URL を拾う
function mediaImage(block) {
  // media:content は動画のこともある（YouTube は flash の URL が入っている）ので、画像のときだけ使う
  for (const m of block.matchAll(/<media:content\b([^>]*)\/?>/gi)) {
    const type = (m[1].match(/type=["']([^"']+)["']/i) || [])[1] || "";
    const medium = (m[1].match(/medium=["']([^"']+)["']/i) || [])[1] || "";
    const url = (m[1].match(/url=["']([^"']+)["']/i) || [])[1] || "";
    if (url && (/^image\//i.test(type) || medium === "image" || (!type && !medium && /\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(url)))) return decodeEntities(url);
  }
  const mt = attr(block, "media:thumbnail", "url");
  if (mt) return mt;
  const m = block.match(/<enclosure\b([^>]*)\/?>/i);
  if (m) {
    const attrs = m[1];
    const type = (attrs.match(/type=["']([^"']+)["']/i) || [])[1] || "";
    const url = (attrs.match(/url=["']([^"']+)["']/i) || [])[1] || "";
    if (url && (!type || /^image\//i.test(type))) return decodeEntities(url);
  }
  return "";
}
