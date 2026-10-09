import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export async function fetchText(url, { timeoutMs = 20000, headers = {}, method = "GET", body } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, body, headers: { "user-agent": UA, ...headers }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// リダイレクトを手動で追い、最終的な URL を返す
export async function resolveRedirect(url, { maxHops = 5, timeoutMs = 15000 } = {}) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(current, { method: "GET", redirect: "manual", headers: { "user-agent": UA }, signal: ac.signal });
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      return current;
    } finally {
      clearTimeout(t);
    }
  }
  return current;
}

const TRACKING_PARAMS = /^(utm_|ref$|ref_|source$|fbclid|gclid|mc_)/i;

// 比較用に URL を正規化（トラッキングパラメータ・末尾スラッシュ・www を除去）
export function normalizeUrl(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    s = s.replace(/\/+$/, "").replace(/\?$/, "");
    return s;
  } catch {
    return input.trim();
  }
}

// 表示用 URL（ref=... などトラッキングだけ落とす）
export function cleanUrl(input) {
  try {
    const u = new URL(input);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\?$/, "");
  } catch {
    return input;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function idOf(url) {
  return createHash("sha1").update(normalizeUrl(url)).digest("hex").slice(0, 12);
}

export async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { error: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

export function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

export function truncate(s, n) {
  if (!s) return "";
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
