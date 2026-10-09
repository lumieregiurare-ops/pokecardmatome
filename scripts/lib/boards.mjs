// 抽選ボード・これからの予定・商品の一覧を作る。collect.mjs と pages.mjs から使う。
// どれも見出しのことばから機械的に読み取ったもの（extract.mjs）。
import {
  findProductNames,
  matchKnownProducts,
  productKey,
  productSlug,
  findSchedule,
  findLotteryDates,
  isLotteryText,
  lotteryMethod,
  lotteryStatus,
  bigrams,
  similarity,
  jstMidnight,
  ymd,
} from "./extract.mjs";

const DAY = 86400000;
// 抽選ボードに載せるのは、この日数以内に出た記事だけ
const LOTTERY_DAYS = 21;
// 予定・商品の一覧に使う記事の範囲
const POOL_DAYS = 120;
const SCHEDULE_AHEAD = 120;
const ENDED_RE = /(?:応募|受付|販売|抽選)(?:は|を)?終了|終了しました|締め?切りました|〆切りました/;

// ---------- 商品名の辞書（data/products.json） ----------
// 見出しの「拡張パック「〇〇」」から見つけた名前を貯めていく。
// 1 度覚えた名前は、かっこ無しで書かれた見出し（「〇〇の再販はいつ？」など）からも拾えるようになる。
export function updateProducts(db, items, aliases, nowIso) {
  db.products ||= [];
  const today = nowIso.slice(0, 10);
  const byKey = new Map(db.products.map((p) => [p.key, p]));
  const aliasTo = new Map(Object.entries(aliases || {}).map(([a, name]) => [productKey(a), name]));
  const canonical = (name) => aliasTo.get(productKey(name)) || byKey.get(productKey(name))?.name || name;

  for (const it of items) {
    for (const found of findProductNames(it.title)) {
      const name = canonical(found);
      const key = productKey(name);
      if (key.length < 3) continue;
      const p = byKey.get(key);
      if (p) {
        if (p.lastSeen !== today) p.lastSeen = today;
      } else {
        const np = { name, key, slug: productSlug(name), firstSeen: today, lastSeen: today };
        byKey.set(key, np);
        db.products.push(np);
      }
    }
  }
  db.products.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : a.key < b.key ? -1 : 1));
  const matcher = productMatcher(db, aliases);
  for (const it of items) it.products = matcher(it.title);
  return db.products.map((p) => p.name);
}

// 見出しに出てくる商品名（辞書にあるもの）を返す関数を作る。表記ゆれ（aliases）も拾う
export function productMatcher(db, aliases = {}) {
  const variants = new Map();
  for (const p of db.products || []) variants.set(p.name, p.name);
  for (const [a, name] of Object.entries(aliases)) variants.set(a, name);
  const names = [...variants.keys()];
  return (text) => [...new Set(matchKnownProducts(text, names).map((n) => variants.get(n)))];
}

// ---------- ボード ----------
export function buildBoards({ items, archive, config, productDb, now }) {
  const nowMs = now.getTime();
  const todayMs = jstMidnight(nowMs);
  const today = ymd(todayMs);
  const matchProducts = productMatcher(productDb, config.productAliases);

  // いまの記事（新しい値を持っている）を優先し、貯めた記事で補う
  const pool = new Map();
  for (const it of items) pool.set(it.id, it);
  for (const d of archive || []) {
    for (const it of d.items) {
      if (pool.has(it.id)) continue;
      if (nowMs - new Date(it.publishedAt).getTime() > POOL_DAYS * DAY) continue;
      pool.set(it.id, it);
    }
  }
  const all = [...pool.values()].map((it) => ({ ...it, products: matchProducts(it.title) }));
  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const brief = (it) => ({
    id: it.id,
    title: it.title,
    url: it.url,
    source: it.source,
    image: it.image || "",
    publishedAt: it.publishedAt,
    series: it.series || [],
    stores: it.stores || [],
    products: it.products || [],
    isOfficial: !!it.isOfficial,
  });

  // ---------- これからの予定 ----------
  const sched = [];
  const releaseVotes = new Map(); // 商品名 → { 日付: 票 }
  for (const it of all) {
    const s = findSchedule(it.title, it.publishedAt);
    if (!s) continue;
    if (s.act === "release" || s.act === "launch") {
      for (const p of it.products) {
        if (!releaseVotes.has(p)) releaseVotes.set(p, new Map());
        const v = releaseVotes.get(p);
        v.set(s.day, (v.get(s.day) || 0) + 1);
      }
    }
    const days = Math.round((s.date - todayMs) / DAY);
    if (days < 0 || days > SCHEDULE_AHEAD) continue;
    sched.push({ ...brief(it), day: s.day, time: s.time, act: s.act, actLabel: s.actLabel, bi: bigrams(it.title), count: 1 });
  }
  sched.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : new Date(b.publishedAt) - new Date(a.publishedAt)));
  // 同じ日の同じ発表は 1 つにまとめる（同じ商品が出てくるか、見出しがよく似ているもの）
  const schedule = [];
  for (const x of sched) {
    const dup = schedule.find(
      (k) => k.day === x.day && k.act === x.act && (k.products.some((p) => x.products.includes(p)) || similarity(k.bi, x.bi) > 0.45)
    );
    if (dup) {
      dup.count++;
      if (!dup.image && x.image) dup.image = x.image;
      if (!dup.time && x.time) dup.time = x.time;
      if (x.isOfficial && !dup.isOfficial) Object.assign(dup, { title: x.title, url: x.url, source: x.source, isOfficial: true });
      continue;
    }
    schedule.push(x);
  }
  for (const x of schedule) delete x.bi;

  // ---------- 抽選・予約ボード ----------
  const cands = [];
  for (const it of all) {
    if (nowMs - new Date(it.publishedAt).getTime() > LOTTERY_DAYS * DAY) continue;
    const isLot = (it.categories || []).includes("lottery") || isLotteryText(it.title);
    if (!isLot) continue;
    const dates = findLotteryDates(`${it.title} ${it.summary || ""}`, it.publishedAt);
    const e = { ...brief(it), host: it.host || "", method: lotteryMethod(it.title), ...dates };
    e.status = lotteryStatus(e, today);
    // 「応募は終了しました」「受付終了」と見出しにあるものは締切済み
    if (ENDED_RE.test(it.title)) {
      e.status = "closed";
      e.ended = true;
      e.deadline ||= ymd(jstMidnight(new Date(it.publishedAt).getTime()));
    }
    // 締切から 2 日を過ぎたものは載せない
    if (e.status === "closed" && (Date.parse(today) - Date.parse(e.deadline)) / DAY > 2) continue;
    e.bi = bigrams(it.title);
    cands.push(e);
  }
  const rank = { today: 0, open: 1, soon: 2, info: 3, closed: 4 };
  cands.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if (a.status === "open" || a.status === "today") {
      // 締切のわかるものを先に、締切の近い順
      if (!!a.deadline !== !!b.deadline) return a.deadline ? -1 : 1;
      if (a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    }
    if (a.status === "soon" && a.start !== b.start) return a.start < b.start ? -1 : 1;
    // 店や商品のわかるものを先に
    const ia = (a.stores.length ? 1 : 0) + (a.products.length ? 1 : 0);
    const ib = (b.stores.length ? 1 : 0) + (b.products.length ? 1 : 0);
    if (ia !== ib) return ib - ia;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });
  const lottery = [];
  const perHost = new Map();
  for (const e of cands) {
    // 同じ受付を複数の媒体が報じているものはまとめる
    const dup = lottery.find((k) => k.deadline === e.deadline && similarity(k.bi, e.bi) > 0.6);
    if (dup) {
      dup.count = (dup.count || 1) + 1;
      for (const s of e.stores) if (!dup.stores.includes(s)) dup.stores.push(s);
      if (!dup.image && e.image) dup.image = e.image;
      continue;
    }
    const n = perHost.get(e.host) || 0;
    if (!e.isOfficial && n >= 3) continue;
    perHost.set(e.host, n + 1);
    lottery.push({ ...e, count: 1 });
    if (lottery.length >= 48) break;
  }
  for (const e of lottery) delete e.bi;

  // ---------- 商品の一覧 ----------
  const prodCount = new Map();
  const prodLatest = new Map();
  for (const it of all) {
    if (nowMs - new Date(it.publishedAt).getTime() > 45 * DAY) continue;
    for (const p of it.products) {
      prodCount.set(p, (prodCount.get(p) || 0) + 1);
      if (!prodLatest.has(p)) prodLatest.set(p, it.publishedAt);
    }
  }
  const slugOf = new Map((productDb.products || []).map((p) => [p.name, p.slug]));
  const products = [...prodCount.entries()]
    .filter(([, n]) => n >= 2)
    .map(([name, count]) => ({ name, slug: slugOf.get(name) || productSlug(name), count, release: pickRelease(releaseVotes.get(name), today), latestAt: prodLatest.get(name) }))
    .sort((a, b) => b.count - a.count || (a.latestAt < b.latestAt ? 1 : -1))
    .slice(0, 40);

  // ---------- 店舗の一覧（抽選ボードと直近の記事での登場数） ----------
  const storeCount = new Map();
  for (const it of all) {
    if (nowMs - new Date(it.publishedAt).getTime() > LOTTERY_DAYS * DAY) continue;
    for (const s of it.stores || []) storeCount.set(s, (storeCount.get(s) || 0) + 1);
  }
  const stores = (config.stores || [])
    .map((s) => ({ id: s.id, label: s.label, count: storeCount.get(s.id) || 0, open: lottery.filter((e) => e.stores.includes(s.id) && (e.status === "open" || e.status === "today")).length }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.open - a.open || b.count - a.count);

  return { lottery, schedule: schedule.slice(0, 80), products, stores };
}

// いちばん多く書かれている発売日。同じ票なら、これから来る日を優先する
function pickRelease(votes, today) {
  if (!votes) return "";
  return [...votes.entries()].sort((a, b) => b[1] - a[1] || (b[0] >= today) - (a[0] >= today) || (a[0] < b[0] ? 1 : -1))[0]?.[0] || "";
}
