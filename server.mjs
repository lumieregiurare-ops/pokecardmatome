// ローカル確認用の静的サーバー（docs/ をそのまま配る）。
// 公開は docs/ をロリポップに置くだけでよく、このサーバーは不要。収集は GitHub Actions が行う
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = join(ROOT, "docs");
const config = JSON.parse(await readFile(join(ROOT, "config.json"), "utf8"));
const PORT = Number(process.env.PORT || config.port || 3210);
const HOST = process.env.HOST || config.host || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function log(...a) {
  console.log(`[${new Date().toLocaleString("ja-JP")}]`, ...a);
}

const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  let file = normalize(join(DOCS, path));
  if (!file.startsWith(DOCS)) {
    res.writeHead(403);
    return res.end();
  }
  // ディレクトリは index.html を返す（末尾スラッシュなしはリダイレクト）— Apache / GitHub Pages と同じ挙動
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith("/")) {
      res.writeHead(301, { location: path + "/" });
      return res.end();
    }
    file = join(file, "index.html");
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // 本番（.htaccess の ErrorDocument）と同じく 404.html を返す
    const notFound = join(DOCS, "404.html");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    return existsSync(notFound) ? createReadStream(notFound).pipe(res) : res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nポート ${PORT} は別のプロセスが使用中です（すでに npm start したサーバーが動いていませんか？）。`);
    console.error(`  確認: netstat -ano | findstr :${PORT}   停止: taskkill /PID <PID> /F`);
    console.error(`  別ポートで起動する場合: set PORT=3211 && npm start\n`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, HOST, () => log(`pokecardmatome: http://localhost:${PORT}  (serving docs/, bind ${HOST})`));
