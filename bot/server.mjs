// Запуск бота на обычном Node.js (bothost и любой VPS).
// Тот же код, что для Cloudflare Workers (src/index.js), но:
//  — база: SQLite в DATA_DIR (по умолчанию /app/data) через встроенный node:sqlite;
//  — HTTP-сервер: вебхук Telegram (/tg), API мини-аппа (/api/*), статика (/app, /fonts);
//  — расписание: напоминания 12:00 МСК и сводка владельцу 09:00 МСК.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from './src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const PORT = Number(process.env.PORT || 3000);
mkdirSync(DATA_DIR, { recursive: true });

/* ---------- База: SQLite с интерфейсом как у Cloudflare D1 ---------- */
const sqlite = new DatabaseSync(join(DATA_DIR, 'tehnomotorika.db'));
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
sqlite.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));

class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { const s = new Stmt(this.sql); s.args = args.map((a) => (a === undefined ? null : a)); return s; }
  _first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  _all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  _run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
  async first() { return this._first(); }
  async all() { return this._all(); }
  async run() { return this._run(); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  // batch — одна транзакция: если упадёт хоть один запрос (например, ячейка занята), откатывается всё.
  async batch(stmts) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = stmts.map((s) => s._run());
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },
};

/* ---------- Секреты: из окружения или сгенерированные один раз ---------- */
const secretsFile = join(DATA_DIR, 'secrets.json');
const saved = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {};
const secrets = {
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || saved.WEBHOOK_SECRET || randomBytes(24).toString('hex'),
  ADMIN_CODE: process.env.ADMIN_CODE || saved.ADMIN_CODE || String(randomInt(100000, 999999)),
};
writeFileSync(secretsFile, JSON.stringify(secrets));

const env = {
  DB,
  BOT_TOKEN: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
  WEBHOOK_SECRET: secrets.WEBHOOK_SECRET,
  ADMIN_CODE: secrets.ADMIN_CODE,
  TG_API: process.env.TG_API,
  DEV_AUTH: process.env.DEV_AUTH,
};
if (!env.BOT_TOKEN) { console.error('BOT_TOKEN не задан'); process.exit(1); }

/* ---------- Статика мини-аппа ---------- */
const PUBLIC = join(HERE, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function staticFile(pathname) {
  let p = pathname === '/app' || pathname === '/app/' ? '/app/index.html' : pathname;
  if (!p.startsWith('/app/') && !p.startsWith('/fonts/')) return null;
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return null;
  return { body: readFileSync(file), type: TYPES[extname(file)] || 'application/octet-stream', cache: p.startsWith('/fonts/') || p.startsWith('/app/img/') };
}

/* ---------- HTTP ---------- */
function publicOrigin(req) {
  if (process.env.DOMAIN) return `https://${process.env.DOMAIN}`;
  if (process.env.WEBHOOK_URL) return new URL(process.env.WEBHOOK_URL).origin;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, publicOrigin(req));
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    const st = req.method === 'GET' ? staticFile(url.pathname) : null;
    if (st) {
      res.writeHead(200, { 'content-type': st.type, 'cache-control': st.cache ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return res.end(st.body);
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await worker.fetch(request, env);
    const out = Buffer.from(await response.arrayBuffer());
    const h = {}; response.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(response.status, h);
    res.end(out);
  } catch (e) {
    console.error('http error', e);
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`ТехноМоторика: слушаю 0.0.0.0:${PORT}, база ${join(DATA_DIR, 'tehnomotorika.db')}`);
  // Регистрируем вебхук, команды и кнопку мини-аппа на публичном адресе.
  const origin = process.env.DOMAIN ? `https://${process.env.DOMAIN}` : process.env.WEBHOOK_URL ? new URL(process.env.WEBHOOK_URL).origin : null;
  if (!origin) { console.log('DOMAIN не задан: включите домен в настройках бота на bothost.'); return; }
  try {
    const r = await worker.fetch(new Request(`${origin}/setup?key=${env.WEBHOOK_SECRET}`), env);
    const info = await r.json();
    console.log('Telegram:', JSON.stringify(info));
    console.log(`Код владельца: /admin ${env.ADMIN_CODE}`);
  } catch (e) { console.error('setup error', e); }
});

/* ---------- Расписание (по Москве) ---------- */
let lastRun = {};
setInterval(async () => {
  const msk = new Date(Date.now() + 3 * 3600e3);
  const hhmm = msk.getUTCHours() * 100 + msk.getUTCMinutes();
  const day = msk.toISOString().slice(0, 10);
  const jobs = [[900, '0 6 * * *'], [1200, '0 9 * * *']];
  for (const [at, cron] of jobs) {
    if (hhmm >= at && hhmm < at + 5 && lastRun[cron] !== day) {
      lastRun[cron] = day;
      try { await worker.scheduled({ cron }, env); console.log('cron', cron, 'ok'); } catch (e) { console.error('cron', cron, e); }
    }
  }
}, 30_000);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); sqlite.close(); process.exit(0); });
