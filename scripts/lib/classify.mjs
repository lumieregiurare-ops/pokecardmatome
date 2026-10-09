// config.json の語の一覧から、記事の振り分けに使う関数をまとめて作る。
import { makeStoreMatcher } from "./extract.mjs";

const compile = (list, flags = "i") => (list || []).map((k) => new RegExp(k, flags));

export function classify(config) {
  const topicRe = compile(config.keywords);
  const categories = (config.categories || []).map((c) => ({ id: c.id, label: c.label, re: compile(c.keywords) }));
  const series = (config.series || []).map((s) => ({ id: s.id, label: s.label, re: compile(s.keywords) }));
  const defaultSeries = config.defaultSeries || series[0]?.id || "";
  const fallback = config.fallbackCategory || { id: "other", label: "その他" };
  const blockTitleRe = compile(config.blockTitlePatterns, "");
  const blockSourceRe = compile(config.blockSources);
  const prRe = compile(config.prSources);
  const detectStores = makeStoreMatcher(config.stores);
  const officialHosts = config.officialHosts || [];

  // 件数の上限。host は媒体ごと、pattern は見出しの型ごと
  const caps = config.caps || [];
  const hostCaps = new Map(caps.filter((c) => c.host).map((c) => [c.host, c.max]));
  const patternCaps = caps.filter((c) => c.pattern).map((c) => ({ re: new RegExp(c.pattern), max: c.max }));
  const defaultPerHost = caps.find((c) => c.defaultPerHost)?.defaultPerHost ?? Infinity;

  return {
    categories: categories.map(({ id, label }) => ({ id, label })),
    series: series.map(({ id, label }) => ({ id, label })),
    fallback,
    detectStores,
    isTopic: (text) => topicRe.some((re) => re.test(text)),
    isPR: (source) => prRe.some((re) => re.test(source || "")),
    // 媒体名とドメインのどちらかが blockSources に当たれば載せない
    isBlocked: (title, source, host) =>
      blockTitleRe.some((re) => re.test(title)) || blockSourceRe.some((re) => re.test(source || "") || re.test(host || "")),
    isOfficialHost: (host) => officialHosts.some((h) => host === h || (host || "").endsWith("." + h)),

    // 当たった語が多い種別から 2 つまで
    categorize(text) {
      const scored = categories
        .map((c) => ({ id: c.id, n: c.re.reduce((a, re) => a + (re.test(text) ? 1 : 0), 0) }))
        .filter((s) => s.n > 0)
        .sort((a, b) => b.n - a.n);
      return scored.length ? scored.slice(0, 2).map((s) => s.id) : [fallback.id];
    },

    // ポケポケ・海外のどちらにも当たらなければ紙のポケカの話とみなす
    detectSeries(text) {
      const hit = series.filter((s) => s.id !== defaultSeries && s.re.some((re) => re.test(text))).map((s) => s.id);
      return hit.length ? hit : [defaultSeries];
    },

    // items は新しい順に並んでいること。公式の発表は数えない
    applyCaps(items) {
      const perHost = new Map();
      const perPattern = patternCaps.map(() => 0);
      return items.filter((it) => {
        if (it.isOfficial) return true;
        const limit = hostCaps.get(it.host) ?? defaultPerHost;
        const n = perHost.get(it.host) || 0;
        if (n >= limit) return false;
        for (let i = 0; i < patternCaps.length; i++) {
          if (!patternCaps[i].re.test(it.title)) continue;
          if (perPattern[i] >= patternCaps[i].max) return false;
        }
        for (let i = 0; i < patternCaps.length; i++) if (patternCaps[i].re.test(it.title)) perPattern[i]++;
        perHost.set(it.host, n + 1);
        return true;
      });
    },
  };
}
