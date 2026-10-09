// 同じ出来事を報じた記事をまとめて「トピック」にする。
// 外部の AI は使わず、見出しから取り出した固有名詞のような語の重なりで判定する。

// 見出しから特徴語を取り出す
//  - 英数字の連なり（MEGA, SAR, 30th など）
//  - カタカナの連なり（ハイクラスパック、チャンピオンズリーグ など）
//  - 漢字の連なり（再販、抽選販売 など）
export function tokenize(text, { stopwords = new Set(), entities = [] } = {}) {
  const t = (text || "").replace(/[「」『』【】（）()\[\]｜|・,.、。！!？?:：;；〜~＋+"'"']/g, " ");
  const tokens = new Set();

  // 辞書に載っている企業名・製品名は表記ゆれを吸収して優先的に拾う
  for (const e of entities) {
    if (new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(t)) tokens.add(e.toLowerCase());
  }

  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9.+-]{2,}/g)) {
    const w = m[0].toLowerCase().replace(/[.+-]+$/, "");
    if (w.length >= 3 && !stopwords.has(w)) tokens.add(w);
  }
  for (const m of t.matchAll(/[ァ-ヴー]{3,}/g)) {
    const w = m[0];
    if (!stopwords.has(w)) tokens.add(w);
  }
  for (const m of t.matchAll(/[一-龥]{2,}/g)) {
    const w = m[0];
    if (!stopwords.has(w)) tokens.add(w);
  }
  return tokens;
}

// 2 つの見出しがどれくらい同じ話題か（共通語の割合）
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / Math.min(a.size, b.size);
}

export function buildTopics(items, cfg = {}, entities = []) {
  const stopwords = new Set(cfg.stopwords || []);
  const windowMs = (cfg.windowHours ?? 40) * 3600000;
  const minSources = cfg.minSources ?? 2;
  const threshold = cfg.threshold ?? 0.34;

  // 新しい順に見て、似ている記事を既存のかたまりに足していく
  const sorted = [...items].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const withTokens = sorted.map((it) => ({ item: it, tokens: tokenize(`${it.title} ${it.summary || ""}`, { stopwords, entities }) }));
  const groups = [];

  for (const cur of withTokens) {
    let best = null;
    let bestScore = threshold;
    for (const g of groups) {
      const gap = Math.abs(new Date(cur.item.publishedAt) - new Date(g.newestAt));
      if (gap > windowMs) continue;
      const score = similarity(cur.tokens, g.tokens);
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    if (best) {
      best.members.push(cur.item);
      for (const t of cur.tokens) best.tokens.add(t);
    } else {
      groups.push({ members: [cur.item], tokens: new Set(cur.tokens), newestAt: cur.item.publishedAt });
    }
  }

  // 複数の媒体が報じたものだけを「トピック」として扱う
  const topics = [];
  for (const g of groups) {
    // 同じ媒体が別の名前（GameWith と ゲームウィズ）で来ることがあるので、ドメインで数える
    const sources = [...new Set(g.members.map((m) => m.host || m.source))];
    if (sources.length < minSources) continue;
    // 代表記事は、プレスリリースでないもの・説明があるものを優先
    const lead =
      g.members.find((m) => !m.isPR && m.summary) || g.members.find((m) => !m.isPR) || g.members[0];
    // 代表記事に画像がなくても、同じ話題の別記事が画像を持っていればそれを使う
    const image = lead.image || g.members.find((m) => m.image)?.image || "";
    topics.push({
      id: lead.id,
      title: lead.title,
      summary: lead.summary || "",
      url: lead.url,
      image,
      leadSource: lead.source,
      publishedAt: g.members.reduce((a, m) => (m.publishedAt > a ? m.publishedAt : a), g.members[0].publishedAt),
      sourceCount: sources.length,
      articleCount: g.members.length,
      categories: [...new Set(g.members.flatMap((m) => m.categories || []))].slice(0, 2),
      keywords: pickKeywords(g, entities),
      articles: g.members
        .filter((m) => m.url !== lead.url)
        .slice(0, 8)
        .map((m) => ({ title: m.title, url: m.url, source: m.source, publishedAt: m.publishedAt, isPR: !!m.isPR })),
    });
  }

  // 媒体が多い順 → 記事数 → 新しい順
  topics.sort(
    (a, b) => b.sourceCount - a.sourceCount || b.articleCount - a.articleCount || new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  return topics.slice(0, cfg.maxTopics ?? 12);
}

// 見出しに何度も出てくる語を、そのトピックの見出しタグにする
function pickKeywords(group, entities) {
  const count = new Map();
  const ent = new Set(entities.map((e) => e.toLowerCase()));
  for (const m of group.members) {
    for (const t of group.tokens) {
      if (new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(m.title)) count.set(t, (count.get(t) || 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || (ent.has(b[0]) ? 1 : 0) - (ent.has(a[0]) ? 1 : 0))
    .filter(([t, n]) => n >= 2 && t.length >= 2)
    .slice(0, 3)
    .map(([t]) => (ent.has(t) ? entities.find((e) => e.toLowerCase() === t) : t));
}
