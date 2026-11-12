// Тест API мини-аппа: подпись initData, запись, гонка с ботом, отмена.
import http from 'node:http';
import { createHmac } from 'node:crypto';

const WORKER = 'http://127.0.0.1:8787';
const BOT_TOKEN = 'test';
const sent = [];
const tgServer = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => { sent.push({ method: req.url.split('/').pop(), payload: body ? JSON.parse(body) : {} }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: 1, username: 'tehnomotorika_test_bot' } })); });
});
await new Promise((r) => tgServer.listen(9999, '127.0.0.1', r));

let failures = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failures++; };

export function signInitData(user, token = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE' + user.id, user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const call = async (path, init, user, opts = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-init-data'] = opts.raw ?? signInitData(user, opts.token);
  const r = await fetch(WORKER + '/api' + path, { method: init?.method || 'GET', headers, body: init?.body ? JSON.stringify(init.body) : undefined });
  return { status: r.status, ...(await r.json()) };
};

const U1 = { id: 5001, first_name: 'Анна', username: 'anna' };
const U2 = { id: 5002, first_name: 'Борис' };

// --- подпись
ok((await call('/init')).status === 401, 'без initData — 401');
ok((await call('/init', null, U1, { token: 'wrong' })).status === 401, 'подпись чужим токеном — 401');
ok((await call('/init', null, U1, { raw: signInitData(U1).replace('Анна', 'Hack').replace('%D0%90%D0%BD%D0%BD%D0%B0', 'Hack') })).status === 401, 'изменённые данные пользователя — 401');
ok((await call('/init', null, U1, { raw: signInitData(U1, BOT_TOKEN, Math.floor(Date.now() / 1000) - 90000) })).status === 401, 'просроченная подпись (25 ч) — 401');

const init = await call('/init', null, U1);
ok(init.status === 200 && init.services.length === 10 && init.profile.name === 'Анна', '/init: услуги и профиль');

// --- дни и слоты
const days = await call('/days?svc=to', null, U1);
ok(days.days.length >= 11 && !days.days.some((d) => d.wd === 'Вс'), 'дни на 2 недели без воскресений');
const day = days.days.find((d, i) => i >= 2 && d.free > 0).key;
let slots = await call(`/slots?svc=to&day=${day}`, null, U1);
ok(slots.slots[0].time === '10:00' && slots.slots.at(-1).time === '19:00' && slots.slots[0].range === '10:00–12:00', 'слоты ТО: 10:00…19:00, диапазон 10:00–12:00');

// --- запись
ok((await call('/book', { method: 'POST', body: { svc: 'to', day, cell: 0, phone: '12' } }, U1)).error === 'phone', 'плохой телефон отклонён');
let mark = sent.length;
const b1 = await call('/book', { method: 'POST', body: { svc: 'to', day, cell: 0, phone: '8 (900) 111-22-33', car: 'BMW M5 E60' } }, U1);
ok(b1.status === 200 && b1.booking.range === '10:00–12:00' && b1.booking.car === 'BMW M5 E60', 'запись через мини-апп');
ok(sent.slice(mark).some((c) => c.payload.chat_id === 5001 && /Вы записаны/.test(c.payload.text)), 'клиенту пришло подтверждение в чат');
const init2 = await call('/init', null, U1);
ok(init2.profile.phone === '+7 900 111-22-33' && init2.bookings.length === 1, 'телефон сохранён, запись в «Ваших записях»');

// --- пересечение и гонка
ok((await call('/book', { method: 'POST', body: { svc: 'oil', day, cell: 3, phone: '+79002223344' } }, U2)).status === 409, 'пересечение с чужим ТО — 409');
const race = await Promise.all([
  call('/book', { method: 'POST', body: { svc: 'align', day, cell: 12, phone: '+79000000011' } }, { id: 6001, first_name: 'A' }),
  call('/book', { method: 'POST', body: { svc: 'oil', day, cell: 12, phone: '+79000000012' } }, { id: 6002, first_name: 'B' }),
  call('/book', { method: 'POST', body: { svc: 'ac', day, cell: 13, phone: '+79000000013' } }, { id: 6003, first_name: 'C' }),
]);
ok(race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 2, 'три одновременные пересекающиеся записи — прошла одна');
slots = await call(`/slots?svc=oil&day=${day}`, null, U2);
ok(!slots.slots.some((s) => ['10:00', '11:30', '16:00', '16:30'].includes(s.time)) && slots.slots.some((s) => s.time === '12:00'), 'занятое время исчезло из слотов');

// --- отмена
ok((await call('/cancel', { method: 'POST', body: { id: b1.booking.id } }, U2)).status === 400, 'чужую запись отменить нельзя');
ok((await call('/cancel', { method: 'POST', body: { id: b1.booking.id } }, U1)).ok === true, 'своя запись отменена');
slots = await call(`/slots?svc=oil&day=${day}`, null, U2);
ok(slots.slots[0].time === '10:00', 'после отмены 10:00 снова свободно');

// --- прошлое и мусор
ok((await call('/book', { method: 'POST', body: { svc: 'oil', day: '20200101', cell: 0, phone: '+79001112233' } }, U1)).status === 400, 'дата в прошлом отклонена');
ok((await call('/book', { method: 'POST', body: { svc: 'nope', day, cell: 0, phone: '+79001112233' } }, U1)).status === 400, 'несуществующая услуга отклонена');
ok((await call('/book', { method: 'POST', body: { svc: 'to', day, cell: 20, phone: '+79001112233' } }, U1)).status === 400, 'ТО в 20:00 (вылезает за 21:00) отклонено');

// --- статика
const app = await fetch(WORKER + '/app');
ok(app.status === 200 && /Запись на сервис/.test(await app.text()), '/app отдаёт мини-апп');
ok((await fetch(WORKER + '/fonts/geologica-cyrillic.woff2')).status === 200, 'шрифт отдаётся');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
tgServer.close();
process.exit(failures ? 1 : 0);
