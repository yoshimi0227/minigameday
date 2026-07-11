// GameDay 対象アプリ (アプリ層)。
// - GET /healthz : プロセス生存のみ返す (ALB ヘルスチェック用 / DB 非依存)
// - GET /        : データ層(Aurora)へ SELECT 1 を実行し、可否で 200/503 を返す
//                  (canary が叩くのはここ。DB フェイルオーバー時に 503 となり振り返りで可視化される)
const http = require('http');
const mysql = require('mysql2/promise');

const PORT = 80;
const { DB_HOST, DB_PORT, DB_NAME } = process.env;

let creds = {};
try {
  creds = JSON.parse(process.env.DB_SECRET || '{}');
} catch (e) {
  console.error('failed to parse DB_SECRET', e);
}

async function checkDb() {
  // リクエストごとに短命接続を張る。フェイルオーバー時の切断を素早く検知するため。
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT) || 3306,
    user: creds.username,
    password: creds.password,
    database: DB_NAME,
    connectTimeout: 3000,
  });
  try {
    await conn.query('SELECT 1');
  } finally {
    await conn.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive' }));
    return;
  }

  try {
    await checkDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', db: 'reachable', host: DB_HOST }));
  } catch (err) {
    // DB に到達できない = データ層障害。canary はこの 503 を捉える。
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'degraded', db: 'unreachable', error: String(err && err.message ? err.message : err) }));
  }
});

server.listen(PORT, () => console.log(`gameday app listening on :${PORT}`));
