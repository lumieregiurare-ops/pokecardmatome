// ポケカならではの情報を見出しから読み取る。
//  - 店舗（ポケモンセンター・ヨドバシ など）
//  - 商品名（拡張パック「〇〇」の〇〇）
//  - 日付つきの予定（「10月17日発売」「10/12まで受付」）と、抽選・予約の締切
// どれも見出しのことばから機械的に読むだけなので、まちがうことがある。
// 画面では「見出しから読み取った日付です」と添えて、必ずリンク先を見てもらう。
// Node の標準機能だけで動く（collect.mjs と pages.mjs の両方から使う）。

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");

// 日本時間の「その日の 0 時」を UTC のミリ秒で返す
export function jstMidnight(ms) {
  const d = new Date(ms + 9 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
export function ymd(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 全角の英数字・記号を半角にそろえる（「１０月１７日」「１０／１７」も読めるように）
export function toHalf(s) {
  return String(s || "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

function compile(list) {
  return (list || []).map((k) => new RegExp(k, "i"));
}

// ---------- 店舗 ----------
export function makeStoreMatcher(stores) {
  const defs = (stores || []).map((s) => ({ id: s.id, label: s.label, re: compile(s.keywords) }));
  return (text) => defs.filter((d) => d.re.some((re) => re.test(text))).map((d) => d.id);
}

// ---------- 商品名 ----------
// 「拡張パック「〇〇」」のように、商品の種類のすぐ後ろのかぎかっこを商品名とみなす
const PRODUCT_TYPE =
  "(?:強化拡張パック|拡張パック|ハイクラスパック|スペシャルセット|スペシャルBOX|スペシャルボックス|スターターデッキ(?:&ビルドセット)?|スターターセット(?:ex)?|デッキビルドBOX|デッキビルドボックス|プレミアムトレーナーボックス|プレミアムデッキセット|プレミアムコレクション|プレミアムBOX|コレクションBOX|コレクションボックス|ジムセット|カードセット|ギフトボックス|ギフトBOX|プロモカードパック|エキスパンションパック|新弾|最新弾|新パック|テーマ拡張パック|スペシャルデッキセット)";
const RE_TYPED = new RegExp(`(${PRODUCT_TYPE})\\s*(?:ex\\s*)?[「『]([^」』]{2,32})[」』]`, "g");
// 拡張パック以外（スターターセット「イーブイex」・スペシャルBOX「ヒロシマ」など）は、かっこの中だけだと
// カード名や地名と区別できないので、種類を付けた名前にする
const BARE_TYPES = /^(?:強化拡張パック|拡張パック|ハイクラスパック|新弾|最新弾|新パック|テーマ拡張パック|エキスパンションパック)$/;
// 【ポケカ】「〇〇」の予約・抽選… / 【ポケカ】〇〇の再販はいつ？ のような、まとめ記事の見出し
const RE_LEAD_QUOTED = /】\s*[「『]([^」』]{2,32})[」』]\s*の?\s*(?:予約|抽選|再販|収録|当たり|発売|封入|最新情報|カードリスト)/g;
const RE_LEAD_PLAIN = /【(?:ポケカ|ポケモンカード)[^】]{0,6}】\s*([^【】「」『』|｜/／]{2,24})の(?:予約|抽選|再販|当たり|収録カード|封入率|発売日|最新情報|カードリスト)/g;
// 商品名として扱わない語（かぎかっこの中に入りやすい一般的な語）
const NOT_PRODUCT = /^(?:ポケカ|ポケモンカード(?:ゲーム)?|ポケポケ|ポケモン|新弾|最新弾|抽選|予約|再販|まとめ|公式|商品|発売日|BOX|ボックス|パック|.*(?:とは|まとめ|ランキング|一覧|いつ|方法)[？?]?)$/i;

export function normProductName(raw) {
  let s = toHalf(raw)
    .replace(/\s+/g, " ")
    .replace(/^(?:ポケモンカードゲーム|ポケカ)\s*/, "")
    .replace(/^(?:MEGA|スカーレット&バイオレット|ソード&シールド)\s+(?=(?:強化)?拡張パック)/, "")
    .trim();
  // 「ハイクラスパックMEGA(メガ)」の読みがなは落とす
  s = s.replace(/\s*[(（][ぁ-ゟ゠-ヿー]+[)）]\s*$/, "").trim();
  if (s.length < 2 || s.length > 32) return "";
  if (NOT_PRODUCT.test(s)) return "";
  if (/^[\d\s.,/]+$/.test(s)) return "";
  return s;
}

// 見出しから商品名を拾う（かぎかっこ・まとめ記事の型に当たるものだけ）
export function findProductNames(title) {
  const t = toHalf(title);
  const out = new Set();
  for (const m of t.matchAll(RE_TYPED)) {
    const n = normProductName(m[2]);
    if (!n) continue;
    out.add(BARE_TYPES.test(m[1]) || n.startsWith(m[1].slice(0, 4)) ? n : `${m[1]} ${n}`);
  }
  for (const re of [RE_LEAD_QUOTED, RE_LEAD_PLAIN]) {
    for (const m of t.matchAll(re)) {
      const n = normProductName(m[1]);
      if (n) out.add(n);
    }
  }
  return [...out];
}

// 名前の一部が別の名前になっているとき（「メガブレイブ」と「ブレイブ」など）は長いほうを優先する
export function matchKnownProducts(text, names) {
  const t = productKey(text);
  const hit = names.filter((n) => {
    const k = productKey(n);
    return k.length >= 4 && t.includes(k);
  });
  return hit.filter((n) => !hit.some((o) => o !== n && productKey(o).includes(productKey(n))));
}

// 表記ゆれ（空白の有無・大文字小文字）をそろえた比較用のキー
export function productKey(name) {
  return toHalf(name).replace(/[\s・]+/g, "").toLowerCase();
}

export function productSlug(name) {
  const ascii = toHalf(name).toLowerCase().trim();
  if (/^[a-z0-9][a-z0-9 ._&+-]*$/.test(ascii)) {
    const s = ascii.replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (s.length >= 2) return s;
  }
  // 日本語の名前は、名前から作るハッシュを使う（同じ名前なら毎回同じ値になる）
  let h = 2166136261;
  for (const c of productKey(name)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return "p" + h.toString(36);
}

// ---------- 日付 ----------
// 「2026年10月17日」「10月17日(金)」「10/17」「10月17・18日」などを拾う
const DATE_RE = /(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(?<![\d/.])(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})(?![\d/])/g;
const WD_PAREN = /^\s*[(（][月火水木金土日・祝休]{1,3}[)）]/;
const TIME_RE = /^\s*(\d{1,2})[:：時](\d{2})?分?/;

// 記事が出た日を基準に年を決める（年末の記事の「1月10日発売」は翌年、年明けの「12月20日」は前年）
function resolveYear(mo, d, explicitYear, pubMs) {
  if (explicitYear) return Date.UTC(Number(explicitYear), mo - 1, d);
  const pub = new Date(pubMs + 9 * 3600000);
  const y = pub.getUTCFullYear();
  let date = Date.UTC(y, mo - 1, d);
  const pubDay = jstMidnight(pubMs);
  if (date - pubDay < -150 * DAY) date = Date.UTC(y + 1, mo - 1, d);
  else if (date - pubDay > 250 * DAY) date = Date.UTC(y - 1, mo - 1, d);
  return date;
}

// 見出しの中の日付を、出てきた順にすべて返す。after は日付のすぐ後ろの文字列
export function findDates(title, publishedAt) {
  const t = toHalf(title);
  const pubMs = new Date(publishedAt).getTime() || Date.now();
  const out = [];
  DATE_RE.lastIndex = 0;
  for (const m of t.matchAll(DATE_RE)) {
    const mo = Number(m[2] || m[5]);
    const d = Number(m[3] || m[6]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
    const date = resolveYear(mo, d, m[1] || m[4], pubMs);
    let rest = t.slice(m.index + m[0].length);
    let wd = rest.match(WD_PAREN);
    if (wd) rest = rest.slice(wd[0].length);
    let time = "";
    const tm = rest.match(TIME_RE);
    if (tm && Number(tm[1]) <= 24) {
      time = `${pad(tm[1])}:${tm[2] || "00"}`;
      rest = rest.slice(tm[0].length);
    }
    out.push({ date, day: ymd(date), time, explicitYear: !!(m[1] || m[4]), index: m.index, end: t.length - rest.length, after: rest, before: t.slice(Math.max(0, m.index - 12), m.index) });
  }
  return out;
}

// 日付の後ろに続く語から、それが何の日かを決める
const ACTS = [
  { id: "deadline", label: "締切", re: /^[^。！!]{0,6}?(?:まで|迄|締め?切|〆切|〆)/ },
  { id: "lottery", label: "抽選・受付", re: /^[^。！!]{0,14}?(?:抽選|応募|エントリー|受付開始|受付|当選発表)/ },
  { id: "preorder", label: "予約開始", re: /^[^。！!]{0,14}?(?:予約)/ },
  { id: "restock", label: "再販・入荷", re: /^[^。！!]{0,14}?(?:再販|再入荷|入荷|再出荷|出荷|再生産)/ },
  { id: "release", label: "発売", re: /^[^。！!]{0,14}?(?:発売|販売開始|販売|リリース)/ },
  { id: "event", label: "開催", re: /^[^。！!]{0,14}?(?:開催|開幕|オープン|大会|イベント|体験会)/ },
  { id: "launch", label: "配信・公開", re: /^[^。！!]{0,14}?(?:配信|実装|登場|追加|公開|解禁|開始|スタート)/ },
];

// 毎日のように「更新」されて流れてくる、まとめ・一覧の記事の見出し
const EVERGREEN_RE = /まとめ|一覧|ランキング|とは|いつ[？?]|早見表/;

// 予定として扱える日付を 1 つ選ぶ（見出しの最初に当たったもの）
export function findSchedule(title, publishedAt) {
  const pubDay = jstMidnight(new Date(publishedAt).getTime() || Date.now());
  const evergreen = EVERGREEN_RE.test(title);
  for (const d of findDates(title, publishedAt)) {
    // 「【9/24更新】」「9月24日時点」は記事の更新日なので予定ではない
    if (/^\s*(?:更新|時点|現在|最新|版|号)/.test(d.after)) continue;
    // 予定の発表は、ふつう数か月前まで。まとめ記事の「【1/20発売】」は何年も前の商品のことが多いので、
    // 年が書かれていないものは近い日付だけを信じる
    const ahead = (d.date - pubDay) / DAY;
    if (ahead < -3 || ahead > 150) continue;
    if (evergreen && !d.explicitYear && ahead > 60) continue;
    for (const a of ACTS) {
      if (a.re.test(d.after)) return { ...d, act: a.id, actLabel: a.label };
    }
  }
  return null;
}

// ---------- 抽選・予約 ----------
const LOTTERY_RE = /抽選|予約|応募|受付|エントリー|先着|整理券|当選|販売方法/;
const METHOD = [
  ["抽選", /抽選|応募|当選|エントリー/],
  ["先着", /先着/],
  ["整理券", /整理券/],
  ["予約", /予約/],
];

export function isLotteryText(text) {
  return LOTTERY_RE.test(text);
}

// 締切・受付開始の日付を見出し（と要約）から読む
export function findLotteryDates(text, publishedAt) {
  const t = toHalf(text);
  const pubMs = new Date(publishedAt).getTime() || Date.now();
  const dates = findDates(t, publishedAt);
  let deadline = null;
  let start = null;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const next = dates[i + 1];
    // 「10月10日～10月14日」「10/10〜14日」の範囲は、後ろが締切・前が開始
    const between = next ? t.slice(d.end, next.index) : "";
    if (next && /^\s*[～〜~\-ー－から]{1,3}\s*$/.test(between)) {
      start ||= d;
      deadline ||= next;
      i++;
      continue;
    }
    if (/^\s*[～〜~]?\s*(?:まで|迄|締め?切|〆切|〆)/.test(d.after)) deadline ||= d;
    else if (/(?:締め?切|〆切)[はり：:]*\s*$/.test(d.before)) deadline ||= d;
    else if (/^\s*(?:から|より|～|〜)?\s*(?:抽選|受付|予約|応募|エントリー)/.test(d.after)) start ||= d;
  }
  // 「本日締切」「本日まで」「明日まで」
  if (!deadline) {
    const pubDay = jstMidnight(pubMs);
    if (/(?:本日|今日)(?:中)?(?:締め?切|〆切|まで)/.test(t)) deadline = { date: pubDay, day: ymd(pubDay), time: "" };
    else if (/明日(?:締め?切|〆切|まで)/.test(t)) deadline = { date: pubDay + DAY, day: ymd(pubDay + DAY), time: "" };
  }
  return {
    deadline: deadline ? deadline.day : "",
    deadlineTime: deadline?.time || "",
    start: start ? start.day : "",
  };
}

export function lotteryMethod(text) {
  for (const [label, re] of METHOD) if (re.test(text)) return label;
  return "情報";
}

// ---------- 見出しの似かた ----------
// 同じ発表を複数の媒体が報じたものを 1 つにまとめるのに使う（2 文字ずつの重なり）
export function bigrams(s) {
  const t = toHalf(s)
    .replace(/[「」『』【】（）()\[\]\s!！?？・、。〜～:：|｜"“”'’]/g, "")
    .replace(/ポケモンカード(?:ゲーム)?|ポケカ|ポケポケ/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
export function similarity(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
}

// 抽選・予約の受付状況。today は日本時間の "YYYY-MM-DD"
export function lotteryStatus(e, today) {
  if (e.deadline) {
    if (e.deadline < today) return "closed";
    if (e.deadline === today) return "today";
    if (e.start && e.start > today) return "soon";
    return "open";
  }
  // 締切がわからないときは、受付開始から 5 日までを「受付中」とみなす
  if (e.start) {
    if (e.start > today) return "soon";
    const days = (Date.parse(today) - Date.parse(e.start)) / DAY;
    return days <= 5 ? "open" : "info";
  }
  return "info";
}
