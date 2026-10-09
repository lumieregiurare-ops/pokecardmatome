// 見出しからの読み取り（extract.mjs）と振り分け（classify.mjs）のテスト。npm test で流す。
// 見出しは実際に収集した記事のもの。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findProductNames,
  matchKnownProducts,
  productSlug,
  findSchedule,
  findLotteryDates,
  lotteryStatus,
  lotteryMethod,
  makeStoreMatcher,
} from "../lib/extract.mjs";
import { classify } from "../lib/classify.mjs";
import { fetchPageList } from "../lib/sources.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
// 日本時間 2026-10-09 12:00
const PUB = "2026-10-09T03:00:00Z";

test("商品名: 種類のすぐ後ろのかぎかっこを拾う", () => {
  assert.deepEqual(findProductNames("『ポケカ』拡張パック「インフェルノX」「ストームエメラルダ」がポケセンオンラインで追加抽選中！"), ["インフェルノX"]);
  assert.deepEqual(findProductNames("DeNA、『ポケポケ』で拡張パック「ハイクラスパック MEGA」追加"), ["ハイクラスパック MEGA"]);
  assert.deepEqual(findProductNames("【ポケポケ】新パック「ハイクラスパックMEGA(メガ)」の収録カード一覧"), ["ハイクラスパックMEGA"]);
  // 拡張パック以外は種類を付けて持つ（カード名・地名と区別するため）
  assert.deepEqual(findProductNames("【ポケカ】スターターセットex「イーブイex」の予約・抽選情報まとめ"), ["スターターセットex イーブイex"]);
  assert.deepEqual(findProductNames("ヒロシマのピカチュウ プロモの買取｜スペシャルBOX「ヒロシマ」"), ["スペシャルBOX ヒロシマ"]);
});

test("商品名: まとめ記事の見出しの型から拾う", () => {
  assert.deepEqual(findProductNames("【ポケカ】ロケット団の栄光の当たりランキング/買取相場/封入率/予約抽選/値段まとめ"), ["ロケット団の栄光"]);
  assert.deepEqual(findProductNames("【ポケカ】30th CELEBRATIONの再販はいつ？再販入荷情報まとめ【9/24更新】"), ["30th CELEBRATION"]);
  // カード 1 枚の相場ページは商品にしない
  assert.deepEqual(findProductNames("【ポケカ】ミュウex URの買取価格と最新相場と値段推移｜ポケモンカード151"), []);
});

test("商品名: 覚えた名前を空白の有無を問わず拾い、長いほうを優先する", () => {
  const names = ["ハイクラスパック MEGA", "メガブレイブ", "ブレイブ", "30th CELEBRATION"];
  assert.deepEqual(matchKnownProducts("ポケポケに「ハイクラスパックMEGA」が登場", names), ["ハイクラスパック MEGA"]);
  assert.deepEqual(matchKnownProducts("【ポケカ】メガブレイブの収録カードリスト", names), ["メガブレイブ"]);
  assert.equal(productSlug("30th CELEBRATION"), "30th-celebration");
  assert.match(productSlug("ストームエメラルダ"), /^p[0-9a-z]+$/);
  assert.equal(productSlug("ハイクラスパック MEGA"), productSlug("ハイクラスパックMEGA"));
});

test("予定: 日付の後ろの語で種類を決める", () => {
  const a = findSchedule("『ポケポケ』で特別な拡張パック「ハイクラスパック MEGA」を9月30日10時より追加", "2026-09-24T03:00:00Z");
  assert.equal(a.day, "2026-09-30");
  assert.equal(a.time, "10:00");
  assert.equal(a.act, "launch");
  const b = findSchedule("ローソン、ポケカMEGA新商品「30th CELEBRATION カードセット」の一部商品を2026年10月16日7:00から店頭販売", PUB);
  assert.equal(b.day, "2026-10-16");
  assert.equal(b.act, "release");
  const c = findSchedule("ヨドバシで「ストームエメラルダ」の抽選受付、１０月１２日（日）まで", PUB);
  assert.equal(c.day, "2026-10-12");
  assert.equal(c.act, "deadline");
});

test("予定: 更新日・何年も前の商品の発売日は予定にしない", () => {
  assert.equal(findSchedule("【ポケカ】ブラックボルトの予約・抽選情報まとめ【6月5日更新】", PUB), null);
  // まとめ記事の「【1/20発売】」は 2023 年の商品のこと（年が書かれていないので来年にしない）
  assert.equal(findSchedule("【ポケカ】「スカーレットex＆バイオレットex スペシャルセット」の収録アイテムリスト/予約/抽選まとめ【1/20発売】", "2026-09-28T03:00:00Z"), null);
  // カード番号（134/103）を日付と読まない
  assert.equal(findSchedule("ミュウツーex FUR [M6a 134/103] 発売", PUB), null);
});

test("予定: 年末の記事の「1月」は翌年", () => {
  const s = findSchedule("新弾「〇〇」1月23日発売決定", "2026-12-20T03:00:00Z");
  assert.equal(s.day, "2027-01-23");
});

test("抽選: 締切と受付開始を読む", () => {
  assert.deepEqual(findLotteryDates("ゲオで抽選販売中！10月1日17:59まで受付", "2026-09-28T03:00:00Z"), { deadline: "2026-10-01", deadlineTime: "17:59", start: "" });
  assert.deepEqual(findLotteryDates("ポケセンオンラインで抽選 10/10〜10/14", PUB), { deadline: "2026-10-14", deadlineTime: "", start: "2026-10-10" });
  assert.deepEqual(findLotteryDates("抽選受付は本日締切", PUB), { deadline: "2026-10-09", deadlineTime: "", start: "" });
  assert.deepEqual(findLotteryDates("締め切りは10月20日（月）", PUB), { deadline: "2026-10-20", deadlineTime: "", start: "" });
  assert.deepEqual(findLotteryDates("ポケカ新弾の抽選情報まとめ", PUB), { deadline: "", deadlineTime: "", start: "" });
  assert.equal(lotteryMethod("先着順で予約受付"), "先着");
  assert.equal(lotteryMethod("抽選販売のお知らせ"), "抽選");
});

test("抽選: 受付状況", () => {
  const today = "2026-10-09";
  assert.equal(lotteryStatus({ deadline: "2026-10-09" }, today), "today");
  assert.equal(lotteryStatus({ deadline: "2026-10-12" }, today), "open");
  assert.equal(lotteryStatus({ deadline: "2026-10-08" }, today), "closed");
  assert.equal(lotteryStatus({ deadline: "2026-10-20", start: "2026-10-12" }, today), "soon");
  assert.equal(lotteryStatus({ start: "2026-10-07" }, today), "open");
  assert.equal(lotteryStatus({ start: "2026-09-20" }, today), "info");
  assert.equal(lotteryStatus({}, today), "info");
});

test("店舗: 別の語の一部は数えない", () => {
  const m = makeStoreMatcher(config.stores);
  assert.deepEqual(m("ポケセンオンラインで追加抽選"), ["pokemoncenter"]);
  assert.deepEqual(m("ヨドバシ.comで抽選受付中"), ["yodobashi"]);
  assert.deepEqual(m("ライオンのイラストが話題"), []);
  assert.deepEqual(m("ポケモンカード体験会実施 inイオンモールむさし村山"), []);
  assert.deepEqual(m("東北楽天ゴールデンイーグルスとコラボ"), []);
  assert.deepEqual(m("【2026.10.06】抽選販売 ホビーステーション hbst.net"), ["cardshop"]);
});

test("振り分け: 種別・ゲーム・除外", () => {
  const C = classify(config);
  assert.deepEqual(C.categorize("ポケセンオンラインで追加抽選中"), ["lottery"]);
  assert.deepEqual(C.detectSeries("【ポケポケ】メガハッサムexデッキのレシピと評価"), ["pocket"]);
  assert.deepEqual(C.detectSeries("ポケモンカード、30周年の新弾"), ["tcg"]);
  assert.equal(C.isBlocked("【A（きれいな状態）】ミュウツーex FUR [M6a 134/103]", "SNKRDUNK", "snkrdunk.com"), true);
  assert.equal(C.isBlocked("わるいヤドキング ★ : 旧裏 [neo4 No.199]", "x", "x"), true);
  assert.equal(C.isBlocked("ふつうのニュース", "Unisba Media", "media.unisba.ac.id"), true);
  assert.equal(C.isBlocked("ポケカの新弾が発表", "4Gamer", "4gamer.net"), false);
  assert.equal(C.isOfficialHost("shop.pokemon.co.jp"), true);
  assert.equal(C.isOfficialHost("fakepokemon.co.jp"), false);
});

test("振り分け: 媒体・見出しの型ごとの件数制限", () => {
  const C = classify({ ...config, caps: [{ host: "a.com", max: 2 }, { pattern: "相場価格と値段推移", max: 1 }, { defaultPerHost: 3 }] });
  const mk = (host, title, isOfficial = false) => ({ host, title, isOfficial });
  const kept = C.applyCaps([
    mk("a.com", "1"),
    mk("a.com", "2"),
    mk("a.com", "3"),
    mk("b.com", "X の相場価格と値段推移"),
    mk("b.com", "Y の相場価格と値段推移"),
    mk("b.com", "4"),
    mk("b.com", "5"),
    mk("b.com", "6"),
    mk("pokemon-card.com", "公式 1", true),
  ]);
  assert.deepEqual(kept.map((x) => x.title), ["1", "2", "X の相場価格と値段推移", "4", "5", "公式 1"]);
});

test("お知らせ一覧のページから見出しとリンクを拾う", async () => {
  const html = `<html><body><ul class="news">
    <li><a href="/info/2026/20261009_004321.html"><span class="date">2026.10.09</span><span class="cat">商品</span> 拡張パック「テスト」の抽選販売について</a></li>
    <li><a href="/info/2026/20261008_004320.html">2026.10.08 チャンピオンズリーグ2027 の参加受付について</a></li>
    <li><a href="/info/2026/20261008_004320.html">2026.10.08 チャンピオンズリーグ2027 の参加受付について</a></li>
    <li><a href="/products/">商品一覧</a></li>
  </ul></body></html>`;
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/info/`;
  try {
    const got = await fetchPageList({ name: "公式", url, linkPattern: config.pageLists[0].linkPattern, kind: "official", always: true });
    assert.equal(got.length, 2);
    assert.equal(got[0].title, "拡張パック「テスト」の抽選販売について");
    assert.equal(got[0].url, `http://127.0.0.1:${srv.address().port}/info/2026/20261009_004321.html`);
    assert.equal(got[0].publishedAt, "2026-10-09T01:00:00.000Z");
    assert.equal(got[1].title, "チャンピオンズリーグ2027 の参加受付について");
    assert.equal(got[0].sourceKind, "official");
  } finally {
    srv.close();
  }
});
