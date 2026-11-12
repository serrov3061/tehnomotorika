// Разворачивает бота одной командой: npm run setup
// Делает: вход в Cloudflare → база D1 → таблицы → деплой → секреты → вебхук Telegram.
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const TOML = new URL('../wrangler.toml', import.meta.url);
const DB_NAME = 'tehnomotorika';
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const run = (cmd) => spawnSync(cmd, { shell: true, stdio: 'inherit' });
const step = (t) => console.log(`\n— ${t}`);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const rl = createInterface({ input: stdin, output: stdout });

// 1. Токен бота
step('Токен бота');
console.log('Создайте бота в @BotFather (/newbot) и вставьте токен вида 123456:ABC...');
let token = '';
while (!/^\d+:[\w-]{30,}$/.test(token)) token = (await rl.question('BOT_TOKEN: ')).trim();

// 2. Вход в Cloudflare
step('Вход в Cloudflare');
let who = '';
try { who = sh('npx wrangler whoami'); } catch (e) { who = String(e.stdout || ''); }
if (/not authenticated|You are not/i.test(who)) {
  if (run('npx wrangler login').status !== 0) throw new Error('Не удалось войти в Cloudflare');
} else console.log('Уже вошли.');

// 3. База D1
step('База данных');
let toml = readFileSync(TOML, 'utf8');
if (!UUID.test(toml)) {
  let id = null;
  try {
    const out = sh(`npx wrangler d1 create ${DB_NAME}`);
    id = (out.match(UUID) || [])[0];
  } catch (e) {
    const list = sh('npx wrangler d1 list --json');
    const db = JSON.parse(list.slice(list.indexOf('['))).find((d) => d.name === DB_NAME);
    id = db?.uuid;
  }
  if (!id) throw new Error('Не получилось создать или найти базу D1');
  toml = toml.replace(/database_id = ".*"/, `database_id = "${id}"`);
  writeFileSync(TOML, toml);
  console.log(`База ${DB_NAME}: ${id}`);
} else console.log('База уже привязана.');

step('Таблицы');
if (run(`npx wrangler d1 execute ${DB_NAME} --remote --file=schema.sql --yes`).status !== 0) throw new Error('Не удалось создать таблицы');

// 4. Деплой
step('Деплой');
const dep = spawnSync('npx wrangler deploy', { shell: true, encoding: 'utf8' });
process.stdout.write(dep.stdout || ''); process.stderr.write(dep.stderr || '');
if (dep.status !== 0) throw new Error('Деплой не прошёл');
let url = ((dep.stdout || '') + (dep.stderr || '')).match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
while (!url) {
  const a = (await rl.question('Вставьте адрес воркера из вывода выше (https://...workers.dev): ')).trim().replace(/\/$/, '');
  if (/^https:\/\/[\w.-]+\.workers\.dev$/.test(a)) url = a;
}
rl.close();

// 5. Секреты
step('Секреты');
const secrets = {
  BOT_TOKEN: token,
  WEBHOOK_SECRET: randomBytes(24).toString('hex'),
  ADMIN_CODE: String(randomInt(100000, 999999)),
};
const tmp = new URL('../.secrets.tmp.json', import.meta.url);
writeFileSync(tmp, JSON.stringify(secrets));
try {
  if (run('npx wrangler secret bulk .secrets.tmp.json').status !== 0) throw new Error('Не удалось сохранить секреты');
} finally { unlinkSync(tmp); }

// 6. Вебхук
step('Подключаю Telegram');
let info = null;
for (let i = 0; i < 10 && !info?.webhook; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try { info = await (await fetch(`${url}/setup?key=${secrets.WEBHOOK_SECRET}`)).json(); } catch {}
}
if (!info?.webhook) throw new Error(`Вебхук не установился. Откройте вручную: ${url}/setup?key=${secrets.WEBHOOK_SECRET}`);

console.log(`
Готово.

Бот:              https://t.me/${info.bot}
Ссылка записи:    ${info.link}
Код владельца:    ${secrets.ADMIN_CODE}

Владелец пишет боту:  /admin ${secrets.ADMIN_CODE}
После этого ему будут приходить все записи, а команды /day и /close станут доступны.
Код никому не показывайте.`);
