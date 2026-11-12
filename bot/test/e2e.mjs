// Сквозной тест: локальный wrangler dev + поддельный Telegram API.
// Запуск: npm test (wrangler dev должен быть запущен на :8787 с TG_API=http://127.0.0.1:9999)
import http from 'node:http';

const WORKER = 'http://127.0.0.1:8787';
const SECRET = 'test_secret';
const sent = [];        // все вызовы Telegram API
let msgSeq = 1000;

const tgServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const payload = body ? JSON.parse(body) : {};
    sent.push({ method, payload });
    let result = true;
    if (method === 'sendMessage') result = { message_id: ++msgSeq, chat: { id: payload.chat_id } };
    if (method === 'getMe') result = { username: 'tehnomotorika_test_bot' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => tgServer.listen(9999, '127.0.0.1', r));

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

async function post(update, secret = SECRET) {
  const r = await fetch(`${WORKER}/tg`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) });
  return r.status;
}
const user = (id, first) => ({ id, first_name: first, is_bot: false });
const msg = (uid, first, text, extra = {}) => ({ update_id: Date.now(), message: { message_id: ++msgSeq, from: user(uid, first), chat: { id: uid, type: 'private' }, text, ...extra } });
const cb = (uid, first, data) => ({ update_id: Date.now(), callback_query: { id: String(Math.random()), from: user(uid, first), data, message: { message_id: 1, chat: { id: uid, type: 'private' } } } });

const since = (n) => sent.slice(n);
const last = (pred) => [...sent].reverse().find(pred);
const textTo = (uid) => last((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.chat_id === uid);
const buttons = (call) => (call?.payload.reply_markup?.inline_keyboard || []).flat();

// Первый будний день начиная с послезавтра (по Москве), чтобы не зависеть от текущего часа.
function testDay() {
  const d = new Date(Date.now() + 3 * 3600e3);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
const DAY = testDay();

// --- 0. безопасность вебхука
ok((await post(msg(1, 'X', '/start'), 'wrong')) === 403, 'вебхук без секрета отклоняется');

// --- 1. владелец
await post(msg(900, 'Алексей', '/admin wrongcode'));
ok(/Неверный код/.test(textTo(900).payload.text), 'неверный код владельца отклонён');
await post(msg(900, 'Алексей', '/admin test_code'));
ok(/вы владелец/.test(textTo(900).payload.text), 'владелец зарегистрирован кодом');

// --- 2. клиент A: полный путь записи на ТО (2 ч = 4 ячейки) в 10:00
await post(msg(101, 'Иван', '/start'));
ok(buttons(textTo(101)).some((x) => x.callback_data === 'book'), '/start показывает «Записаться»');
await post(cb(101, 'Иван', 'book'));
ok(buttons(textTo(101)).some((x) => x.callback_data === 's:to'), 'список услуг');
await post(cb(101, 'Иван', 's:to'));
ok(buttons(textTo(101)).some((x) => x.callback_data === `d:to:${DAY}`), 'тестовый день доступен');
ok(!buttons(textTo(101)).some((x) => /Вс /.test(x.text)), 'воскресенья нет в списке дней');
await post(cb(101, 'Иван', `d:to:${DAY}`));
let times = buttons(textTo(101)).map((x) => x.text);
ok(times[0] === '10:00' && times.includes('19:00') && !times.includes('19:30'), 'ТО 2 ч: первое 10:00, последнее 19:00 (до 21:00)');
await post(cb(101, 'Иван', `t:to:${DAY}:0`));
ok(last((c) => c.method === 'sendMessage' && c.payload.chat_id === 101)?.payload.reply_markup?.keyboard?.[0]?.[0]?.request_contact === true, 'просит номер кнопкой');
await post(msg(101, 'Иван', 'абв'));
ok(/Не похоже на номер/.test(textTo(101).payload.text), 'мусор вместо номера отклонён');
await post(msg(101, 'Иван', '', { contact: { phone_number: '89001234567', user_id: 101 } }));
ok(sent.some((c) => c.payload.chat_id === 101 && /\+7 900 123-45-67 сохранён/.test(c.payload.text || '')), 'номер нормализован в +7 900 123-45-67');
ok(/Какая машина/.test(textTo(101).payload.text), 'спрашивает машину');
await post(msg(101, 'Иван', 'BMW X5 2019'));
ok(/Проверьте запись/.test(textTo(101).payload.text) && /10:00–12:00/.test(textTo(101).payload.text), 'экран подтверждения 10:00–12:00');
let mark = sent.length;
await post(cb(101, 'Иван', 'ok'));
ok(/Вы записаны/.test(textTo(101).payload.text), 'клиент A записан');
const adminNote = since(mark).find((c) => c.payload.chat_id === 900 && /Новая запись/.test(c.payload.text || ''));
ok(!!adminNote && /BMW X5 2019/.test(adminNote.payload.text) && /\+7 900 123-45-67/.test(adminNote.payload.text), 'владельцу пришло уведомление с телефоном и авто');
const bookingA = Number(buttons(adminNote).find((x) => x.callback_data.startsWith('ac:')).callback_data.split(':')[1]);

// --- 3. занятое время пропало у других
await post(msg(102, 'Пётр', '/start'));
await post(cb(102, 'Пётр', `d:oil:${DAY}`));
times = buttons(textTo(102)).map((x) => x.text);
ok(!times.includes('10:00') && !times.includes('11:30') && times.includes('12:00'), 'у другого клиента 10:00–11:30 недоступны, 12:00 есть');

// --- 4. попытка «перебить» через подделанную кнопку: замена масла в 11:00 (пересекается с ТО)
await post(cb(102, 'Пётр', `t:oil:${DAY}:2`));
await post(msg(102, 'Пётр', '+7 911 222 33 44'));
await post(cb(102, 'Пётр', 'car:skip'));
await post(cb(102, 'Пётр', 'ok'));
ok(/только что заняли/.test(textTo(102).payload.text), 'пересекающаяся запись отклонена базой');

// --- 5. гонка: два клиента одновременно жмут «Записаться» на одно и то же время 15:00
for (const [id, name, ph] of [[201, 'Гонщик1', '+79000000001'], [202, 'Гонщик2', '+79000000002']]) {
  await post(msg(id, name, '/start'));
  await post(cb(id, name, `t:align:${DAY}:10`));
  await post(msg(id, name, ph));
  await post(cb(id, name, 'car:skip'));
}
await Promise.all([post(cb(201, 'Гонщик1', 'ok')), post(cb(202, 'Гонщик2', 'ok'))]);
const r1 = textTo(201).payload.text, r2 = textTo(202).payload.text;
const wins = [r1, r2].filter((t) => /Вы записаны/.test(t)).length;
const loses = [r1, r2].filter((t) => /только что заняли/.test(t)).length;
ok(wins === 1 && loses === 1, `гонка за 15:00: ровно один записан, второй получил отказ (${wins}/${loses})`);

// --- 6. 20 одновременных попыток на один слот
const ids = Array.from({ length: 20 }, (_, i) => 300 + i);
for (const id of ids) { await post(msg(id, 'R' + id, '/start')); await post(cb(id, 'R' + id, `t:oil:${DAY}:14`)); await post(msg(id, 'R' + id, `+7900${String(id).padStart(7, '0')}`)); await post(cb(id, 'R' + id, 'car:skip')); }
await Promise.all(ids.map((id) => post(cb(id, 'R' + id, 'ok'))));
const okCount = ids.filter((id) => /Вы записаны/.test(textTo(id).payload.text)).length;
ok(okCount === 1, `20 одновременных попыток на 17:00 → записан ровно 1 (${okCount})`);

// --- 7. мои записи и отмена клиентом освобождает время
await post(cb(101, 'Иван', 'my'));
ok(/Ваши записи/.test(textTo(101).payload.text), 'клиент видит свои записи');
await post(cb(102, 'Пётр', `mc:${bookingA}`));
ok(!/Отменить запись\?/.test(textTo(102).payload.text), 'чужую запись отменить нельзя');
mark = sent.length;
await post(cb(101, 'Иван', `mcy:${bookingA}`));
ok(/Запись отменена/.test(textTo(101).payload.text), 'клиент отменил запись');
ok(since(mark).some((c) => c.payload.chat_id === 900 && /Клиент отменил/.test(c.payload.text || '')), 'владелец узнал об отмене');
await post(cb(102, 'Пётр', `d:oil:${DAY}`));
ok(buttons(textTo(102)).some((x) => x.text === '10:00'), 'после отмены 10:00 снова свободно');

// --- 8. владелец закрывает время, клиенты его не видят
await post(cb(900, 'Алексей', `bt:${DAY}:0`));
ok(buttons(textTo(900)).some((x) => x.callback_data === `bl:${DAY}:0:2`), 'владелец выбирает длительность закрытия');
await post(cb(900, 'Алексей', `bl:${DAY}:0:2`));
ok(/закрыто/.test(textTo(900).payload.text), 'время закрыто и видно в расписании');
await post(cb(102, 'Пётр', `d:oil:${DAY}`));
ok(!buttons(textTo(102)).some((x) => x.text === '10:00'), 'закрытое время не предлагается клиентам');
await post(cb(102, 'Пётр', `bl:${DAY}:4:2`));
ok(!/закрыто/.test(textTo(102).payload.text || '') || /ТехноМоторика/.test(textTo(102).payload.text), 'клиент не может вызвать админские кнопки');

// --- 9. владелец отменяет запись клиента — клиент получает уведомление
await post(cb(900, 'Алексей', `ad:${DAY}`));
const day = textTo(900);
const target = buttons(day).find((x) => x.callback_data.startsWith('ac:') && x.text.startsWith('Отменить'));
mark = sent.length;
await post(cb(900, 'Алексей', target.callback_data.replace('ac:', 'acy:')));
ok(since(mark).some((c) => c.method === 'sendMessage' && c.payload.chat_id !== 900 && /Сервис отменил/.test(c.payload.text || '')), 'клиент уведомлён об отмене владельцем');

// --- 10. лимит активных записей
for (const c of [4, 6]) { await post(cb(101, 'Иван', `t:oil:${DAY}:${c}`)); await post(cb(101, 'Иван', 'car:skip')); await post(cb(101, 'Иван', 'ok')); }
await post(cb(101, 'Иван', `t:oil:${DAY}:18`)); await post(cb(101, 'Иван', 'car:skip')); await post(cb(101, 'Иван', 'ok'));
ok(/уже 2 активные записи/.test(textTo(101).payload.text), 'больше 2 активных записей на клиента нельзя');

// --- 11. /book редиректит в бота
const red = await fetch(`${WORKER}/book`, { redirect: 'manual' });
ok(red.status === 302 && /t\.me\/tehnomotorika_test_bot\?start=book/.test(red.headers.get('location')), '/book ведёт в бота');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
tgServer.close();
process.exit(failures ? 1 : 0);
