// ポケカ速報 — data/news.json を読んで画面を描く。
// 記事の文字はすべて textContent で入れる（外部のフィードから来た文字を HTML として扱わない）。
(function () {
  "use strict";

  const $ = (s, root) => (root || document).querySelector(s);
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const PAGE = 30;
  const LOT_FIRST = 10;
  const KEY = { state: "pkc:state", fav: "pkc:fav", read: "pkc:read", ng: "pkc:ng", theme: "pkc:theme" };
  // 画像の無い記事のサムネイルに出す、種別の短い英語名
  const CAT_CODE = {
    lottery: "LOTTERY",
    restock: "RESTOCK",
    release: "RELEASE",
    reveal: "CARDS",
    event: "EVENT",
    promo: "PROMO",
    market: "MARKET",
    deck: "DECK",
    caution: "ALERT",
    goods: "GOODS",
    other: "NEWS",
  };
  const STATUS = {
    today: "本日締切",
    open: "受付中",
    soon: "受付前",
    info: "情報",
    closed: "締切",
  };

  // ---------- 保存 ----------
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 容量超過・プライベートモード */
    }
  }

  const state = Object.assign({ series: "all", cat: "all", store: "", product: "", q: "", lotView: "active", lotStore: "" }, load(KEY.state, {}));
  state.q = "";
  let favs = load(KEY.fav, []);
  const read = new Set(load(KEY.read, []));
  let ng = load(KEY.ng, []);
  let data = null;
  let shown = PAGE;
  let lotAll = false;

  function persist() {
    save(KEY.state, { series: state.series, cat: state.cat, store: state.store, product: state.product, lotView: state.lotView, lotStore: state.lotStore });
  }

  // ---------- 小物 ----------
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const pad = (n) => String(n).padStart(2, "0");
  // 日本時間で読む（海外から見ても、締切や日付の区切りが日本の日付になるように）
  function jst(iso) {
    return new Date(new Date(iso).getTime() + 9 * 3600000);
  }
  function jstDay(iso) {
    return jst(iso).toISOString().slice(0, 10);
  }
  function todayStr() {
    return jstDay(new Date().toISOString());
  }
  function dayDiff(a, b) {
    return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  }
  function md(day) {
    const [, m, d] = day.split("-").map(Number);
    return `${m}/${d}`;
  }
  function wd(day) {
    return WD[new Date(day + "T00:00:00Z").getUTCDay()];
  }
  function hhmm(iso) {
    const d = jst(iso);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function ago(iso) {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return "たった今";
    if (min < 60) return `${min}分前`;
    if (min < 24 * 60) return `${Math.floor(min / 60)}時間前`;
    return `${md(jstDay(iso))} ${hhmm(iso)}`;
  }
  function hash(str) {
    let x = 0;
    for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
    return x;
  }
  const catLabel = (id) => (data.categories.find((c) => c.id === id) || {}).label || "";
  const storeLabel = (id) => (data.stores.find((s) => s.id === id) || {}).label || id;

  function isMuted(it) {
    if (!ng.length) return false;
    const t = `${it.title} ${it.summary || ""} ${it.source || ""}`.toLowerCase();
    return ng.some((w) => t.includes(w.toLowerCase()));
  }

  function markRead(id, row) {
    if (read.has(id)) return;
    read.add(id);
    save(KEY.read, [...read].slice(-600));
    if (row) row.classList.add("is-read");
  }

  function thumb(it, cls) {
    const box = h("a", { class: cls, href: safeUrl(it.url), target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" });
    const ph = () => {
      box.classList.add("thumb-ph");
      box.textContent = CAT_CODE[(it.categories || [])[0]] || "NEWS";
    };
    if (it.image && /^https?:\/\//.test(it.image)) {
      const img = h("img", { src: it.image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
      img.addEventListener("error", () => {
        img.remove();
        ph();
      });
      box.appendChild(img);
    } else ph();
    return box;
  }

  // ---------- ヘッダーの数字 ----------
  function renderMeta() {
    const m = $("#meta");
    m.textContent = "";
    const u = data.updatedAt;
    const c = data.churn || {};
    m.append(
      h(
        "span",
        null,
        h("b", { text: String(data.total) }),
        " 本 ・ 今日 ",
        h("b", { text: String(data.todayCount) }),
        " 本",
        c.newCount ? h("span", null, " ・ 前回から ", h("span", { class: "up", text: `+${c.newCount}` })) : null,
        " ・ 最終更新 ",
        h("b", { text: `${md(jstDay(u))} ${hhmm(u)}` }),
        ` （${ago(u)}）`
      )
    );
    const nx = $("#nextUpdate");
    if (data.nextUpdateAt && new Date(data.nextUpdateAt) > new Date()) {
      nx.hidden = false;
      nx.textContent = `次の更新 ${hhmm(data.nextUpdateAt)} ごろ`;
    } else nx.hidden = true;
  }

  function renderTicker() {
    const box = $("#tickerMove");
    box.textContent = "";
    const list = data.items.filter((it) => !isMuted(it)).slice(0, 14);
    if (!list.length) {
      $("#ticker").hidden = true;
      return;
    }
    // 同じ並びを 2 回入れて、半分まで流したら最初に戻す（つなぎ目が見えないように）
    for (let r = 0; r < 2; r++) {
      for (const it of list) {
        const a = h("a", { href: safeUrl(it.url), target: "_blank", rel: "noopener", tabindex: r ? "-1" : null, "aria-hidden": r ? "true" : null }, h("time", { text: hhmm(it.publishedAt) }), it.title);
        a.addEventListener("click", () => markRead(it.id));
        box.appendChild(a);
      }
    }
    const chars = list.reduce((a, it) => a + it.title.length, 0);
    box.style.setProperty("--tick-dur", `${Math.max(40, Math.round(chars * 0.22))}s`);
  }

  // ---------- 抽選ボード ----------
  function lotStatus(e, today) {
    // 見出しに「受付終了」とあったもの
    if (e.ended) return "closed";
    if (e.deadline) {
      if (e.deadline < today) return "closed";
      if (e.deadline === today) return "today";
      if (e.start && e.start > today) return "soon";
      return "open";
    }
    if (e.start) {
      if (e.start > today) return "soon";
      return dayDiff(today, e.start) <= 5 ? "open" : "info";
    }
    return e.status === "closed" ? "closed" : "info";
  }

  function lotRow(e, today) {
    const st = e._st;
    const when = h("div", { class: "lot-when" });
    // 受付前のものは、締切がわかればそれを大きく出し、開始日を添える
    const target = st === "soon" ? e.deadline || e.start : e.deadline;
    if (target) {
      const left = dayDiff(target, today);
      let leftText = "";
      if (st === "soon") leftText = e.deadline ? `${md(e.start)} から受付` : "受付開始";
      else if (left === 0) leftText = e.deadlineTime ? `本日 ${e.deadlineTime} まで` : "本日まで";
      else if (left > 0) leftText = `あと ${left} 日${e.deadlineTime ? ` ${e.deadlineTime}` : ""}`;
      else leftText = "締切済み";
      when.append(h("span", { class: "d", text: md(target) }), h("span", { class: "wd", text: `(${wd(target)})` }), h("span", { class: "left" + (left <= 1 && st !== "soon" && left >= 0 ? " hot" : ""), text: leftText }));
    } else {
      when.append(h("span", { class: "none", text: "締切は記事で確認" }));
    }
    const tags = h("div", { class: "lot-tags" });
    for (const s of e.stores || []) tags.append(h("span", { class: "tag-store", text: storeLabel(s) }));
    for (const p of (e.products || []).slice(0, 2)) tags.append(h("span", { class: "tag-prod", text: p }));
    if (!tags.childNodes.length || e.method !== "情報") tags.append(h("span", { class: "tag-method", text: e.method }));
    const title = h("a", { class: "lot-title", href: safeUrl(e.url), target: "_blank", rel: "noopener", text: e.title });
    const row = h(
      "div",
      { class: `lot-row is-${st}` + (read.has(e.id) ? " is-read" : "") },
      h("span", { class: `st st-${st}`, text: STATUS[st] }),
      when,
      tags,
      h(
        "div",
        { class: "lot-body" },
        title,
        h(
          "span",
          { class: "lot-meta" },
          e.isOfficial ? h("span", { class: "off", text: "公式" }) : null,
          `${e.source} ・ ${md(jstDay(e.publishedAt))} ${hhmm(e.publishedAt)} 掲載`,
          e.count > 1 ? ` ・ ${e.count} 媒体` : ""
        )
      )
    );
    title.addEventListener("click", () => markRead(e.id));
    return row;
  }

  function renderLottery() {
    const today = todayStr();
    const all = (data.lottery || []).filter((e) => !isMuted(e)).map((e) => Object.assign(e, { _st: lotStatus(e, today) }));
    const rank = { today: 0, open: 1, soon: 2, info: 3, closed: 4 };
    // 締切の近い順。それ以外はサーバーが決めた順（店や商品のわかるものが先）のまま
    all.sort((a, b) => {
      if (rank[a._st] !== rank[b._st]) return rank[a._st] - rank[b._st];
      if ((a._st === "open" || a._st === "today") && (a.deadline || b.deadline)) return (a.deadline || "9").localeCompare(b.deadline || "9");
      return 0;
    });

    // 店舗の絞り込み（ボードに出てくる店だけ）
    const counts = new Map();
    for (const e of all) for (const s of e.stores || []) counts.set(s, (counts.get(s) || 0) + 1);
    if (state.lotStore && !counts.has(state.lotStore)) state.lotStore = "";
    const chips = $("#lotteryStores");
    chips.textContent = "";
    const chip = (id, label, n) =>
      h(
        "button",
        {
          type: "button",
          class: "chip" + (state.lotStore === id ? " active" : ""),
          "aria-pressed": state.lotStore === id ? "true" : "false",
          onclick: () => {
            state.lotStore = id;
            lotAll = false;
            persist();
            renderLottery();
          },
        },
        label,
        n != null ? h("span", { class: "n", text: String(n) }) : null
      );
    chips.append(chip("", "すべての店", null));
    for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)) chips.append(chip(id, storeLabel(id), n));

    for (const b of $("#lotterySeg").querySelectorAll("button")) b.classList.toggle("active", b.dataset.v === state.lotView);

    let list = all;
    if (state.lotStore) list = list.filter((e) => (e.stores || []).includes(state.lotStore));
    if (state.lotView === "active") list = list.filter((e) => e._st !== "closed");
    const box = $("#lotteryList");
    box.textContent = "";
    if (!list.length) {
      box.append(h("p", { class: "board-empty", text: all.length ? "この条件の受付情報はありません。" : "いま受付中の抽選・予約の情報はありません。" }));
    }
    const visible = lotAll ? list : list.slice(0, LOT_FIRST);
    for (const e of visible) box.append(lotRow(e, today));
    const more = $("#lotteryMore");
    more.hidden = list.length <= visible.length;
    more.textContent = `残り ${list.length - visible.length} 件を表示`;
  }

  // ---------- 注目の話題 ----------
  function renderTopics() {
    const list = (data.topics || []).filter((t) => !isMuted(t)).slice(0, 6);
    $("#topicsSection").hidden = !list.length;
    const box = $("#topicList");
    box.textContent = "";
    for (const t of list) {
      const bars = h("span", { class: "bars", "aria-hidden": "true" });
      for (let i = 0; i < Math.min(t.sourceCount, 8); i++) bars.append(h("i"));
      const body = h(
        "div",
        null,
        h("a", { class: "topic-title", href: safeUrl(t.url), target: "_blank", rel: "noopener", text: t.title, onclick: () => markRead(t.id) }),
        h("div", { class: "topic-meta" }, bars, h("span", { text: `${t.sourceCount} 媒体` }), h("span", { text: t.leadSource }), h("time", { datetime: t.publishedAt, text: ago(t.publishedAt) }))
      );
      if ((t.articles || []).length) {
        const ul = h("ul");
        for (const a of t.articles.slice(0, 6)) ul.append(h("li", null, h("a", { href: safeUrl(a.url), target: "_blank", rel: "noopener", text: a.title }), h("span", { class: "s", text: a.source })));
        body.append(h("details", { class: "topic-more" }, h("summary", { text: `ほかの媒体の記事 ${t.articles.length} 件` }), ul));
      }
      const li = h("li", { class: "topic" }, body);
      if (t.image) li.append(thumb(t, "topic-thumb"));
      box.append(li);
    }
  }

  // ---------- 新着 ----------
  function matches(it, skipCat) {
    if (isMuted(it)) return false;
    if (state.series !== "all" && !(it.series || []).includes(state.series)) return false;
    if (!skipCat && state.cat !== "all" && !(it.categories || []).includes(state.cat)) return false;
    if (state.store && !(it.stores || []).includes(state.store)) return false;
    if (state.product && !(it.products || []).includes(state.product)) return false;
    if (state.q) {
      const t = `${it.title} ${it.summary || ""} ${it.source} ${(it.products || []).join(" ")} ${(it.stores || []).map(storeLabel).join(" ")}`.toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w))) return false;
    }
    return true;
  }

  function setFilter(patch) {
    Object.assign(state, patch);
    shown = PAGE;
    persist();
    renderFeed();
    const top = $("#feedSection").getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight) $("#feedSection").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function saveBtn(it) {
    const on = favs.some((f) => f.id === it.id);
    const b = h("button", { type: "button", class: "row-save" + (on ? " on" : ""), "aria-label": on ? "あとで読むから外す" : "あとで読む", "aria-pressed": on ? "true" : "false" });
    b.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M6 3h12v18l-6-4.5L6 21z"/></svg>';
    b.addEventListener("click", () => {
      const i = favs.findIndex((f) => f.id === it.id);
      if (i >= 0) favs.splice(i, 1);
      else favs.unshift({ id: it.id, title: it.title, url: it.url, source: it.source, publishedAt: it.publishedAt, image: it.image || "", categories: it.categories || [], products: it.products || [], stores: it.stores || [] });
      favs = favs.slice(0, 200);
      save(KEY.fav, favs);
      const now = i < 0;
      b.classList.toggle("on", now);
      b.setAttribute("aria-pressed", now ? "true" : "false");
      b.setAttribute("aria-label", now ? "あとで読むから外す" : "あとで読む");
      renderFavCount();
      if (location.hash === "#favorites") renderFavView();
    });
    return b;
  }

  function row(it) {
    const top = h("div", { class: "row-top" });
    if (it.isOfficial) top.append(h("span", { class: "badge badge-official", text: "公式" }));
    if (it.isNew) top.append(h("span", { class: "badge badge-new", text: "NEW" }));
    for (const c of (it.categories || []).slice(0, 2)) if (c !== "other") top.append(h("span", { class: `k k-${c}`, text: catLabel(c) }));
    top.append(h("span", { class: "row-src", text: it.source }), h("time", { datetime: it.publishedAt, text: hhmm(it.publishedAt) }));
    if (it.isPR) top.append(h("span", { class: "badge badge-pr", text: "PR" }));

    const title = h("a", { href: safeUrl(it.url), target: "_blank", rel: "noopener", text: it.title });
    const body = h("div", { class: "row-body" }, top, h("h3", { class: "row-title" }, title));
    if (it.summary) body.append(h("p", { class: "row-sum", text: it.summary }));
    const tags = h("div", { class: "row-tags" });
    for (const s of it.stores || []) tags.append(h("button", { type: "button", class: "tag-store", text: storeLabel(s), title: `${storeLabel(s)}の記事だけを見る`, onclick: () => setFilter({ store: s }) }));
    for (const p of (it.products || []).slice(0, 3)) tags.append(h("button", { type: "button", class: "tag-prod", text: p, title: `${p}の記事だけを見る`, onclick: () => setFilter({ product: p }) }));
    if (tags.childNodes.length) body.append(tags);

    const r = h("article", { class: "row" + (read.has(it.id) ? " is-read" : "") }, thumb(it, "row-thumb"), body, saveBtn(it));
    title.addEventListener("click", () => markRead(it.id, r));
    return r;
  }

  function grouped(list, box) {
    let day = "";
    let rows = null;
    const today = todayStr();
    const counts = {};
    for (const it of list) counts[jstDay(it.publishedAt)] = (counts[jstDay(it.publishedAt)] || 0) + 1;
    for (const it of list) {
      const d = jstDay(it.publishedAt);
      if (d !== day) {
        day = d;
        const diff = dayDiff(today, d);
        const sec = h(
          "section",
          { class: "day" },
          h("h3", { class: "day-head" }, md(d).replace("/", "."), h("small", { text: diff === 0 ? "TODAY" : diff === 1 ? "YESTERDAY" : ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][new Date(d + "T00:00:00Z").getUTCDay()] }), h("span", { class: "n", text: `${counts[d]} 件` }))
        );
        rows = h("div", { class: "rows" });
        sec.append(rows);
        box.append(sec);
      }
      rows.append(row(it));
    }
  }

  function renderCats() {
    const pool = data.items.filter((it) => matches(it, true));
    const box = $("#catTabs");
    box.textContent = "";
    const cats = [{ id: "all", label: "すべて" }, ...data.categories];
    for (const c of cats) {
      const n = c.id === "all" ? pool.length : pool.filter((it) => (it.categories || []).includes(c.id)).length;
      if (c.id !== "all" && !n && state.cat !== c.id) continue;
      box.append(
        h(
          "button",
          { type: "button", class: "cat-tab" + (state.cat === c.id ? " active" : ""), "aria-pressed": state.cat === c.id ? "true" : "false", onclick: () => setFilter({ cat: c.id }) },
          c.label,
          h("span", { class: "n", text: String(n) })
        )
      );
    }
    for (const b of $("#seriesSeg").querySelectorAll("button")) b.classList.toggle("active", b.dataset.v === state.series);
  }

  function renderFilterLine() {
    const box = $("#filterLine");
    box.textContent = "";
    const pills = [];
    if (state.product) pills.push(["商品", state.product, { product: "" }]);
    if (state.store) pills.push(["店舗", storeLabel(state.store), { store: "" }]);
    if (state.q) pills.push(["検索", state.q, { q: "" }]);
    box.hidden = !pills.length;
    if (!pills.length) return;
    box.append("絞り込み:");
    for (const [k, v, patch] of pills) {
      box.append(
        h("button", {
          type: "button",
          class: "filter-pill",
          text: `${k}: ${v}`,
          "aria-label": `${k}「${v}」の絞り込みを外す`,
          onclick: () => {
            if ("q" in patch) $("#q").value = "";
            setFilter(patch);
          },
        })
      );
    }
  }

  function renderFeed() {
    renderCats();
    renderFilterLine();
    const list = data.items.filter((it) => matches(it));
    const box = $("#list");
    box.textContent = "";
    grouped(list.slice(0, shown), box);
    $("#empty").hidden = !!list.length;
    const more = $("#listMore");
    more.hidden = list.length <= shown;
    more.textContent = `さらに ${Math.min(PAGE, list.length - shown)} 件を表示（残り ${list.length - shown} 件）`;
  }

  // ---------- カレンダー ----------
  function renderCalendar() {
    const today = todayStr();
    const list = (data.schedule || []).filter((e) => e.day >= today && !isMuted(e));
    const box = $("#calList");
    box.textContent = "";
    if (!list.length) {
      box.append(h("p", { class: "mod-desc", text: "いまは日付のわかる予定がありません。" }));
      return;
    }
    const days = new Map();
    for (const e of list) {
      if (!days.has(e.day)) days.set(e.day, []);
      days.get(e.day).push(e);
    }
    let shownItems = 0;
    for (const [day, items] of days) {
      if (shownItems >= 12) break;
      const left = dayDiff(day, today);
      const its = h("div", { class: "cal-items" });
      for (const e of items.slice(0, 4)) {
        shownItems++;
        const a = h(
          "a",
          { class: "cal-item", href: safeUrl(e.url), target: "_blank", rel: "noopener" },
          h("span", { class: `a a-${e.act}`, text: e.actLabel }),
          h("span", { class: "t", text: e.title }),
          e.products && e.products.length ? h("span", { class: "p", text: e.products.join(" / ") + (e.time ? ` ・ ${e.time}〜` : "") }) : e.time ? h("span", { class: "p", text: `${e.time}〜` }) : null
        );
        a.addEventListener("click", () => markRead(e.id));
        its.append(a);
      }
      box.append(
        h(
          "div",
          { class: "cal-day" + (left <= 3 ? " is-soon" : "") + (left === 0 ? " is-today" : "") },
          h("div", { class: "cal-date" }, h("span", { class: "md", text: md(day) }), h("span", { class: "wd", text: wd(day) }), h("span", { class: "left", text: left === 0 ? "TODAY" : `あと${left}日` })),
          its
        )
      );
    }
  }

  // ---------- 商品・店舗 ----------
  function renderIndexes() {
    const today = todayStr();
    const prods = (data.products || []).slice(0, 12);
    $("#prodMod").hidden = !prods.length;
    const pl = $("#prodList");
    pl.textContent = "";
    for (const p of prods) {
      const rel = p.release && dayDiff(p.release, today) >= -30 ? `${md(p.release)}${p.release > today ? " 発売" : " 発売済"}` : "";
      pl.append(h("li", null, h("a", { href: `/set/${encodeURIComponent(p.slug)}/` }, h("span", { class: "nm", text: p.name }), rel ? h("span", { class: "rel", text: rel }) : null, h("span", { class: "n", text: String(p.count) }))));
    }
    const stores = (data.stores || []).slice(0, 10);
    $("#storeMod").hidden = !stores.length;
    const sl = $("#storeList");
    sl.textContent = "";
    for (const s of stores) {
      sl.append(h("li", null, h("a", { href: `/store/${encodeURIComponent(s.id)}/` }, h("span", { class: "nm", text: s.label }), s.open ? h("span", { class: "open", text: `受付中 ${s.open}` }) : null, h("span", { class: "n", text: String(s.count) }))));
    }
  }

  function renderSources() {
    const src = (data.sources || []).slice(0, 16);
    $("#srcMod").hidden = !src.length;
    const ul = $("#srcList");
    ul.textContent = "";
    for (const s of src) ul.append(h("li", null, h("span", { text: s.name }), h("span", { class: "n", text: String(s.count) })));
    $("#sourceList").textContent = (data.sources || []).map((s) => s.name).slice(0, 30).join(" / ");
  }

  // ---------- 見たくないことば ----------
  function renderNg() {
    const box = $("#ngList");
    box.textContent = "";
    for (const w of ng) {
      box.append(
        h("button", {
          type: "button",
          text: w,
          "aria-label": `「${w}」を外す`,
          onclick: () => {
            ng = ng.filter((x) => x !== w);
            save(KEY.ng, ng);
            renderAll();
          },
        })
      );
    }
  }

  // ---------- あとで読む ----------
  function renderFavCount() {
    const c = $("#favCount");
    c.hidden = !favs.length;
    c.textContent = String(favs.length);
  }
  function renderFavView() {
    const body = $("#favViewBody");
    body.textContent = "";
    for (const it of favs) body.append(row(it));
    $("#favViewEmpty").hidden = !!favs.length;
  }
  function route() {
    const fav = location.hash === "#favorites";
    $("#favView").hidden = !fav;
    $("#feedSection").hidden = fav;
    $("#topicsSection").hidden = fav || !(data && (data.topics || []).length);
    if (fav) {
      renderFavView();
      $("#favView").scrollIntoView({ block: "start" });
    }
  }

  function renderAll() {
    renderMeta();
    renderTicker();
    renderLottery();
    renderTopics();
    renderFeed();
    renderCalendar();
    renderIndexes();
    renderSources();
    renderNg();
    renderFavCount();
    route();
  }

  // ---------- 操作 ----------
  function bind() {
    $("#seriesSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) setFilter({ series: b.dataset.v });
    });
    $("#lotterySeg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.lotView = b.dataset.v;
      lotAll = false;
      persist();
      renderLottery();
    });
    $("#lotteryMore").addEventListener("click", () => {
      lotAll = true;
      renderLottery();
    });
    $("#listMore").addEventListener("click", () => {
      shown += PAGE;
      renderFeed();
    });
    let timer = 0;
    $("#q").addEventListener("input", (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = e.target.value.trim();
        shown = PAGE;
        if (location.hash === "#favorites") location.hash = "";
        renderFeed();
      }, 180);
    });
    $("#searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      state.q = $("#q").value.trim();
      shown = PAGE;
      renderFeed();
      $("#feedSection").scrollIntoView({ behavior: "smooth" });
    });
    $("#ngForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const w = $("#ngInput").value.trim();
      if (w && !ng.includes(w)) {
        ng.push(w);
        save(KEY.ng, ng);
        renderAll();
      }
      $("#ngInput").value = "";
    });
    $("#favBack").addEventListener("click", () => {
      history.pushState("", document.title, location.pathname + location.search);
      route();
    });
    window.addEventListener("hashchange", route);
    $("#themeBtn").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY.theme, next);
      } catch (e) {
        /* 保存できなくても切り替えだけはする */
      }
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", next === "light" ? "#f2f0e9" : "#0d0e10");
    });
    const toTop = $("#toTop");
    window.addEventListener(
      "scroll",
      () => {
        toTop.hidden = window.scrollY < 900;
      },
      { passive: true }
    );
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // ---------- 起動 ----------
  $("#year").textContent = String(new Date().getFullYear());
  // サブページの検索欄から来たとき（/?q=…）
  try {
    const q = new URLSearchParams(location.search).get("q");
    if (q) {
      state.q = q.trim().slice(0, 60);
      $("#q").value = state.q;
    }
  } catch (e) {
    /* URLSearchParams の無い古いブラウザ */
  }
  bind();
  fetch("data/news.json", { cache: "no-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((j) => {
      data = j;
      data.stores = data.stores || [];
      // サーバー側で作った一覧（検索エンジン向け）を描き直す
      renderAll();
      // 開いたままのタブでも、相対時刻と締切の表示を古くしない
      setInterval(() => {
        renderMeta();
        renderLottery();
      }, 60000);
    })
    .catch(() => {
      $("#meta").textContent = "ニュースを読み込めませんでした。時間をおいて開き直してください。";
    });
})();
