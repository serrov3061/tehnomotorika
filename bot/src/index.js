// ТехноМоторика — бот онлайн-записи (Cloudflare Workers + D1).
import { SERVICES, CONTACTS, CELLS, MAX_ACTIVE_PER_CLIENT } from './config.js';
import {
  todayKey, addDays, isClosed, isValidDay, dayShort, dayLong, rangeText, durationText,
  firstOpenCell, freeStarts, bookableDays, isUpcoming, cellTime,
} from './time.js';

const SVC = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

/* ---------------- Telegram ---------------- */

async function tg(env, method, payload) {
  const base = env.TG_API || 'https://api.telegram.org';
  try {
    const r = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok && !/not modified/i.test(j.description || '')) console.log('tg', method, j.description);
    return j;
  } catch (e) {
    console.log('tg fetch', method, String(e));
    return { ok: false };
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ik = (rows) => ({ inline_keyboard: rows });
const b = (text, data) => ({ text, callback_data: data });
const u = (text, url) => ({ text, url });
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

function send(env, chat, text, markup) {
  return tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
}
/** Редактирует сообщение, если оно есть, иначе шлёт новое. */
function show(env, ctx, text, markup) {
  if (ctx.msgId) return tg(env, 'editMessageText', { chat_id: ctx.chat, message_id: ctx.msgId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
  return send(env, ctx.chat, text, markup);
}

/* ---------------- DB helpers ---------------- */

async function busyCells(env, day) {
  const { results } = await env.DB.prepare('SELECT cell FROM cells WHERE day = ?').bind(day).all();
  return new Set(results.map((r) => r.cell));
}

async function getSession(env, uid) {
  const r = await env.DB.prepare('SELECT data FROM sessions WHERE user_id = ?').bind(uid).first();
  return r ? JSON.parse(r.data) : {};
}
function setSession(env, uid, data) {
  return env.DB.prepare('INSERT INTO sessions(user_id, data, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(uid, JSON.stringify(data), Date.now()).run();
}
function clearSession(env, uid) {
  return env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run();
}
function getClient(env, uid) {
  return env.DB.prepare('SELECT * FROM clients WHERE user_id = ?').bind(uid).first();
}
function saveClient(env, uid, fields) {
  return env.DB.prepare(`INSERT INTO clients(user_id, name, phone, car) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, name), phone = COALESCE(excluded.phone, phone), car = COALESCE(excluded.car, car)`)
    .bind(uid, fields.name ?? null, fields.phone ?? null, fields.car ?? null).run();
}
async function isAdmin(env, uid) {
  return !!(await env.DB.prepare('SELECT 1 FROM admins WHERE user_id = ?').bind(uid).first());
}
async function adminIds(env) {
  const { results } = await env.DB.prepare('SELECT user_id FROM admins').all();
  return results.map((r) => r.user_id);
}
function getBooking(env, id) {
  return env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
}

function newId() {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return (a[0] & 0x1fffff) * 0x100000000 + a[1];
}

/**
 * Атомарная запись. Вставляет запись и все её ячейки одной транзакцией.
 * Если хоть одна ячейка уже занята, PRIMARY KEY(day, cell) роняет вставку,
 * D1 откатывает весь batch, и функция возвращает null.
 */
export async function reserve(env, r) {
  const id = newId();
  const insBooking = env.DB.prepare(`INSERT INTO bookings(id, kind, user_id, name, phone, car, service, day, start, len)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id, r.kind, r.user_id ?? null, r.name ?? null, r.phone ?? null, r.car ?? null, r.service ?? null, r.day, r.start, r.len);
  const ph = [], vals = [];
  for (let c = r.start; c < r.start + r.len; c++) { ph.push('(?,?,?)'); vals.push(r.day, c, id); }
  const insCells = env.DB.prepare(`INSERT INTO cells(day, cell, booking_id) VALUES ${ph.join(',')}`).bind(...vals);
  try {
    await env.DB.batch([insBooking, insCells]);
    return id;
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message || e))) return null;
    throw e;
  }
}

async function release(env, id) {
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'active'").bind(id),
    env.DB.prepare('DELETE FROM cells WHERE booking_id = ?').bind(id),
  ]);
  return res[0].meta.changes > 0;
}

/* ---------------- Тексты ---------------- */

function svcLine(s) {
  return `${s.name}${s.price ? ` · ${s.price}` : ''}`;
}

function bookingText(bk) {
  const s = SVC[bk.service];
  return `${dayLong(bk.day)}, ${rangeText(bk.start, bk.len)}\n${esc(s ? svcLine(s) : bk.service)}`;
}

function clientCard(bk) {
  const who = bk.user_id ? `<a href="tg://user?id=${bk.user_id}">${esc(bk.name || 'Клиент')}</a>` : esc(bk.name || 'Клиент');
  return [`${who}, ${esc(bk.phone || '')}`, bk.car ? esc(bk.car) : null].filter(Boolean).join('\n');
}

const contactsKb = [u('Маршрут', CONTACTS.map), u('Сайт', CONTACTS.site)];

/* ---------------- Клиент ---------------- */

async function homeScreen(env, ctx) {
  await clearSession(env, ctx.uid);
  const text = `<b>ТехноМоторика</b>\nСервис BMW и Mercedes-Benz\n${CONTACTS.hours} · ${CONTACTS.phone}\n\nВыберите услугу и время — оно сразу закрепится за вами.`;
  return show(env, ctx, text, ik([[b('Записаться', 'book')], [b('Мои записи', 'my')], contactsKb]));
}

async function servicesScreen(env, ctx) {
  const rows = SERVICES.map((s) => [b(`${s.name}${s.price ? ` · ${s.price}` : ''}`, `s:${s.id}`)]);
  rows.push([b('← Назад', 'home')]);
  const insp = SVC.insp;
  return show(env, ctx, `<b>Выберите услугу</b>\n\nРемонт двигателя, АКПП, кузова и другие крупные работы — через «${insp.name}»: мастер посмотрит машину и назовёт сроки и цену.`, ik(rows));
}

async function daysScreen(env, ctx, svcId, note = '') {
  const s = SVC[svcId];
  if (!s) return servicesScreen(env, ctx);
  const now = Date.now();
  const days = bookableDays(now);
  const busyAll = await allBusy(env, days[0], days[days.length - 1]);
  const free = days.filter((d) => freeStarts(busyAll.get(d) || new Set(), s.len, firstOpenCell(d, now)).length > 0);
  if (!free.length) {
    return show(env, ctx, `${note}<b>${esc(s.name)}</b>\n\nНа ближайшие две недели свободного времени нет. Позвоните: ${CONTACTS.phone}`, ik([[b('← Услуги', 'book')]]));
  }
  const rows = chunk(free.map((d) => b(dayShort(d), `d:${s.id}:${d}`)), 3);
  rows.push([b('← Услуги', 'book')]);
  return show(env, ctx, `${note}<b>${esc(s.name)}</b> · ${durationText(s.len)}\n\nВыберите день:`, ik(rows));
}

async function allBusy(env, from, to) {
  const { results } = await env.DB.prepare('SELECT day, cell FROM cells WHERE day BETWEEN ? AND ?').bind(from, to).all();
  const m = new Map();
  for (const r of results) { if (!m.has(r.day)) m.set(r.day, new Set()); m.get(r.day).add(r.cell); }
  return m;
}

async function timesScreen(env, ctx, svcId, day, note = '') {
  const s = SVC[svcId];
  if (!s || !isValidDay(day) || isClosed(day)) return daysScreen(env, ctx, svcId);
  const starts = freeStarts(await busyCells(env, day), s.len, firstOpenCell(day, Date.now()));
  if (!starts.length) return daysScreen(env, ctx, svcId, `${note || 'На этот день времени уже нет.'}\n\n`);
  const rows = chunk(starts.map((c) => b(cellTime(c), `t:${s.id}:${day}:${c}`)), 4);
  rows.push([b('← Другой день', `s:${s.id}`)]);
  return show(env, ctx, `${note}<b>${esc(s.name)}</b> · ${durationText(s.len)}\n${dayLong(day)}\n\nВыберите время начала:`, ik(rows));
}

async function pickTime(env, ctx, svcId, day, cell) {
  const s = SVC[svcId];
  cell = Number(cell);
  if (!s || !isValidDay(day) || !Number.isInteger(cell) || cell < 0 || cell + s.len > CELLS) return servicesScreen(env, ctx);
  const sess = { svc: s.id, day, cell };
  const client = await getClient(env, ctx.uid);
  if (!client?.phone) {
    await setSession(env, ctx.uid, { ...sess, step: 'phone' });
    await show(env, ctx, `<b>${esc(s.name)}</b>\n${dayLong(day)}, ${rangeText(cell, s.len)}`, ik([]));
    return send(env, ctx.chat, 'Оставьте номер телефона — по нему мастер свяжется, если что-то поменяется. Нажмите кнопку ниже или напишите номер.', {
      keyboard: [[{ text: 'Отправить номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true,
    });
  }
  return askCar(env, ctx, sess, client);
}

async function askCar(env, ctx, sess, client) {
  await setSession(env, ctx.uid, { ...sess, step: 'car' });
  const rows = [];
  if (client?.car) rows.push([b(client.car, 'car:last')]);
  rows.push([b('Пропустить', 'car:skip')]);
  return show(env, ctx, 'Какая машина? Напишите марку, модель и год, например: <i>BMW X5 2019</i>', ik(rows));
}

async function confirmScreen(env, ctx, sess) {
  const s = SVC[sess.svc];
  const client = await getClient(env, ctx.uid);
  await setSession(env, ctx.uid, { ...sess, step: 'confirm' });
  const text = [
    '<b>Проверьте запись</b>', '',
    esc(svcLine(s)),
    `${dayLong(sess.day)}, ${rangeText(sess.cell, s.len)}`,
    sess.car ? esc(sess.car) : null,
    esc(client?.phone || ''),
  ].filter((x) => x !== null).join('\n');
  return show(env, ctx, text, ik([[b('Записаться', 'ok')], [b('Другое время', `d:${s.id}:${sess.day}`), b('Отмена', 'home')]]));
}

async function commit(env, ctx) {
  const sess = await getSession(env, ctx.uid);
  const s = SVC[sess.svc];
  if (sess.step !== 'confirm' || !s) return homeScreen(env, ctx);
  const client = await getClient(env, ctx.uid);

  const today = todayKey(Date.now());
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND kind = 'client' AND status = 'active' AND day >= ?").bind(ctx.uid, today).first();
  if (active.n >= MAX_ACTIVE_PER_CLIENT) {
    return show(env, ctx, `У вас уже ${active.n} активные записи. Чтобы записаться ещё, отмените одну из них или позвоните: ${CONTACTS.phone}`, ik([[b('Мои записи', 'my')]]));
  }
  if (sess.cell < firstOpenCell(sess.day, Date.now())) {
    return timesScreen(env, ctx, s.id, sess.day, 'Это время уже прошло.\n\n');
  }

  const id = await reserve(env, {
    kind: 'client', user_id: ctx.uid, name: client?.name || ctx.name, phone: client?.phone, car: sess.car || null,
    service: s.id, day: sess.day, start: sess.cell, len: s.len,
  });
  if (!id) return timesScreen(env, ctx, s.id, sess.day, 'Это время только что заняли. Выберите другое.\n\n');

  await clearSession(env, ctx.uid);
  const bk = await getBooking(env, id);
  await show(env, ctx, `<b>Вы записаны</b>\n\n${bookingText(bk)}\n\nЖдём вас. Если планы изменятся — отмените запись, чтобы время освободилось.\n${CONTACTS.phone}`,
    ik([[b('Мои записи', 'my')], contactsKb]));
  for (const a of await adminIds(env)) {
    await send(env, a, `<b>Новая запись</b>\n${bookingText(bk)}\n${clientCard(bk)}`, ik([[b('Отменить запись', `ac:${id}`)]]));
  }
}

async function myScreen(env, ctx) {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE user_id = ? AND kind = 'client' AND status = 'active' AND day >= ? ORDER BY day, start")
    .bind(ctx.uid, todayKey(now)).all();
  const list = results.filter((bk) => isUpcoming(bk.day, bk.start, now));
  if (!list.length) return show(env, ctx, 'Активных записей нет.', ik([[b('Записаться', 'book')], [b('← Назад', 'home')]]));
  const text = ['<b>Ваши записи</b>', ...list.map((bk) => `\n${bookingText(bk)}`)].join('\n');
  const rows = list.map((bk) => [b(`Отменить ${dayShort(bk.day)} ${cellTime(bk.start)}`, `mc:${bk.id}`)]);
  rows.push([b('← Назад', 'home')]);
  return show(env, ctx, text, ik(rows));
}

async function clientCancelAsk(env, ctx, id) {
  const bk = await getBooking(env, id);
  if (!bk || bk.user_id !== ctx.uid || bk.status !== 'active') return myScreen(env, ctx);
  return show(env, ctx, `Отменить запись?\n\n${bookingText(bk)}`, ik([[b('Да, отменить', `mcy:${id}`)], [b('Нет', 'my')]]));
}

async function clientCancel(env, ctx, id) {
  const bk = await getBooking(env, id);
  if (!bk || bk.user_id !== ctx.uid) return myScreen(env, ctx);
  if (await release(env, id)) {
    for (const a of await adminIds(env)) await send(env, a, `<b>Клиент отменил запись</b>\n${bookingText(bk)}\n${clientCard(bk)}`);
  }
  return show(env, ctx, 'Запись отменена, время освободилось.', ik([[b('Записаться снова', 'book')], [b('Мои записи', 'my')]]));
}

/* ---------------- Владелец ---------------- */

async function dayScreen(env, ctx, day) {
  if (!isValidDay(day)) day = todayKey(Date.now());
  const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE day = ? AND status = 'active' ORDER BY start").bind(day).all();
  const head = `<b>${dayLong(day)}</b>`;
  let body;
  if (isClosed(day) && !results.length) body = 'Выходной.';
  else if (!results.length) body = 'Записей нет.';
  else body = results.map((bk) => bk.kind === 'block'
    ? `<b>${rangeText(bk.start, bk.len)}</b> — закрыто`
    : `<b>${rangeText(bk.start, bk.len)}</b> — ${esc(SVC[bk.service]?.name || bk.service)}\n${clientCard(bk)}`).join('\n\n');
  const rows = results.map((bk) => [b(`${bk.kind === 'block' ? 'Открыть' : 'Отменить'} ${cellTime(bk.start)}${bk.kind === 'block' ? '' : ` · ${(bk.name || '').slice(0, 18)}`}`, `ac:${bk.id}`)]);
  rows.push([b('‹', `ad:${addDays(day, -1)}`), b('Сегодня', `ad:${todayKey(Date.now())}`), b('›', `ad:${addDays(day, 1)}`)]);
  rows.push([b('Закрыть время', `bd:${day}`)]);
  return show(env, ctx, `${head}\n\n${body}`, ik(rows));
}

async function adminCancelAsk(env, ctx, id) {
  const bk = await getBooking(env, id);
  if (!bk || bk.status !== 'active') return dayScreen(env, ctx, bk?.day);
  const what = bk.kind === 'block' ? `Открыть время ${rangeText(bk.start, bk.len)}, ${dayLong(bk.day)}?` : `Отменить запись?\n\n${bookingText(bk)}\n${clientCard(bk)}\n\nКлиенту придёт уведомление.`;
  return show(env, ctx, what, ik([[b(bk.kind === 'block' ? 'Да, открыть' : 'Да, отменить', `acy:${id}`)], [b('Нет', `ad:${bk.day}`)]]));
}

async function adminCancel(env, ctx, id) {
  const bk = await getBooking(env, id);
  if (!bk) return dayScreen(env, ctx);
  if (await release(env, id) && bk.kind === 'client' && bk.user_id) {
    await send(env, bk.user_id, `Сервис отменил вашу запись:\n\n${bookingText(bk)}\n\nВыберите другое время или позвоните: ${CONTACTS.phone}`, ik([[b('Записаться', 'book')]]));
  }
  return dayScreen(env, ctx, bk.day);
}

async function blockDayScreen(env, ctx, day) {
  const now = Date.now();
  if (!isValidDay(day) || day < todayKey(now)) day = todayKey(now);
  const starts = freeStarts(await busyCells(env, day), 1, 0).filter((c) => isUpcoming(day, c, now));
  if (!starts.length) return show(env, ctx, `${dayLong(day)}: свободного времени нет.`, ik([[b('← Расписание', `ad:${day}`)]]));
  const rows = chunk(starts.map((c) => b(cellTime(c), `bt:${day}:${c}`)), 4);
  rows.push([b('‹ день', `bd:${addDays(day, -1)}`), b('день ›', `bd:${addDays(day, 1)}`)]);
  rows.push([b('← Расписание', `ad:${day}`)]);
  return show(env, ctx, `<b>Закрыть время</b>\n${dayLong(day)}\n\nС какого времени?`, ik(rows));
}

async function blockLenScreen(env, ctx, day, cell) {
  cell = Number(cell);
  const busy = await busyCells(env, day);
  let maxLen = 0;
  while (cell + maxLen < CELLS && !busy.has(cell + maxLen)) maxLen++;
  if (!maxLen) return blockDayScreen(env, ctx, day);
  const opts = [[2, '1 ч'], [4, '2 ч'], [8, '4 ч']].filter(([l]) => l < maxLen).map(([l, t]) => b(t, `bl:${day}:${cell}:${l}`));
  opts.push(b(`до ${cellTime(cell + maxLen)}`, `bl:${day}:${cell}:${maxLen}`));
  return show(env, ctx, `<b>Закрыть время</b>\n${dayLong(day)}, с ${cellTime(cell)}\n\nНа сколько?`, ik([opts, [b('← Назад', `bd:${day}`)]]));
}

async function blockCommit(env, ctx, day, cell, len) {
  cell = Number(cell); len = Number(len);
  if (!isValidDay(day) || !(len > 0) || cell < 0 || cell + len > CELLS) return blockDayScreen(env, ctx, day);
  const id = await reserve(env, { kind: 'block', day, start: cell, len, name: 'Закрыто' });
  if (!id) return blockDayScreen(env, ctx, day);
  return dayScreen(env, ctx, day);
}

/* ---------------- Роутинг ---------------- */

async function onMessage(env, msg) {
  if (msg.chat?.type !== 'private') return;
  const ctx = { uid: msg.from.id, chat: msg.chat.id, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') };
  const text = (msg.text || '').trim();

  if (text.startsWith('/admin')) {
    const code = text.split(/\s+/)[1];
    if (env.ADMIN_CODE && code === env.ADMIN_CODE) {
      await env.DB.prepare('INSERT OR IGNORE INTO admins(user_id) VALUES(?)').bind(ctx.uid).run();
      await tg(env, 'setMyCommands', { scope: { type: 'chat', chat_id: ctx.chat }, commands: [
        { command: 'day', description: 'Расписание' }, { command: 'close', description: 'Закрыть время' },
        { command: 'book', description: 'Записаться' }, { command: 'my', description: 'Мои записи' }] });
      return send(env, ctx.chat, 'Готово, вы владелец. Сюда будут приходить все новые записи и отмены.\n\n/day — расписание\n/close — закрыть время');
    }
    return send(env, ctx.chat, 'Неверный код.');
  }
  if (text === '/day' || text === '/close') {
    if (!(await isAdmin(env, ctx.uid))) return homeScreen(env, ctx);
    return text === '/day' ? dayScreen(env, ctx, todayKey(Date.now())) : blockDayScreen(env, ctx, todayKey(Date.now()));
  }
  if (text.startsWith('/start')) {
    await saveClient(env, ctx.uid, { name: ctx.name });
    return text.includes('book') ? servicesScreen(env, ctx) : homeScreen(env, ctx);
  }
  if (text === '/book') return servicesScreen(env, ctx);
  if (text === '/my') return myScreen(env, ctx);

  const sess = await getSession(env, ctx.uid);
  if (sess.step === 'phone') {
    const raw = msg.contact?.phone_number || text;
    const phone = normPhone(raw);
    if (!phone) return send(env, ctx.chat, 'Не похоже на номер. Нажмите «Отправить номер» или напишите в формате +7 900 000-00-00.');
    await saveClient(env, ctx.uid, { name: ctx.name, phone });
    await send(env, ctx.chat, `Номер ${phone} сохранён.`, { remove_keyboard: true });
    return askCar(env, { ...ctx, msgId: null }, sess, await getClient(env, ctx.uid));
  }
  if (sess.step === 'car' && text) {
    const car = text.slice(0, 60);
    await saveClient(env, ctx.uid, { car });
    return confirmScreen(env, ctx, { ...sess, car });
  }
  return homeScreen(env, ctx);
}

export function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  if (d.length === 11 && d[0] === '7') return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

async function onCallback(env, cq) {
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!cq.message || cq.message.chat?.type !== 'private') return;
  const ctx = { uid: cq.from.id, chat: cq.message.chat.id, msgId: cq.message.message_id, name: [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') };
  const [k, a1, a2, a3] = String(cq.data || '').split(':');

  switch (k) {
    case 'home': return homeScreen(env, ctx);
    case 'book': return servicesScreen(env, ctx);
    case 'my': return myScreen(env, ctx);
    case 's': return daysScreen(env, ctx, a1);
    case 'd': return timesScreen(env, ctx, a1, a2);
    case 't': return pickTime(env, ctx, a1, a2, a3);
    case 'car': {
      const sess = await getSession(env, ctx.uid);
      if (sess.step !== 'car') return homeScreen(env, ctx);
      const client = await getClient(env, ctx.uid);
      return confirmScreen(env, ctx, { ...sess, car: a1 === 'last' ? client?.car : null });
    }
    case 'ok': return commit(env, ctx);
    case 'mc': return clientCancelAsk(env, ctx, Number(a1));
    case 'mcy': return clientCancel(env, ctx, Number(a1));
  }
  if (!(await isAdmin(env, ctx.uid))) return homeScreen(env, ctx);
  switch (k) {
    case 'ad': return dayScreen(env, ctx, a1);
    case 'ac': return adminCancelAsk(env, ctx, Number(a1));
    case 'acy': return adminCancel(env, ctx, Number(a1));
    case 'bd': return blockDayScreen(env, ctx, a1);
    case 'bt': return blockLenScreen(env, ctx, a1, a2);
    case 'bl': return blockCommit(env, ctx, a1, a2, a3);
  }
}

/* ---------------- Расписание (cron) ---------------- */

async function remindTomorrow(env) {
  const day = addDays(todayKey(Date.now()), 1);
  const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE day = ? AND kind = 'client' AND status = 'active' AND reminded = 0").bind(day).all();
  for (const bk of results) {
    await send(env, bk.user_id, `Напоминаем: завтра вы записаны в ТехноМоторику.\n\n${bookingText(bk)}\n\nЕсли не получится приехать — отмените запись.`, ik([[b('Отменить запись', `mc:${bk.id}`)], contactsKb]));
    await env.DB.prepare('UPDATE bookings SET reminded = 1 WHERE id = ?').bind(bk.id).run();
  }
}

async function morningDigest(env) {
  const day = todayKey(Date.now());
  if (isClosed(day)) return;
  for (const a of await adminIds(env)) await dayScreen(env, { uid: a, chat: a }, day);
}

/* ---------------- Worker ---------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/tg' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const upd = await req.json().catch(() => ({}));
      try {
        if (upd.message) await onMessage(env, upd.message);
        else if (upd.callback_query) await onCallback(env, upd.callback_query);
      } catch (e) {
        console.log('update error', e?.stack || String(e));
      }
      return new Response('ok');
    }
    if (url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const hook = await tg(env, 'setWebhook', { url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      const cmds = await tg(env, 'setMyCommands', { commands: [{ command: 'book', description: 'Записаться' }, { command: 'my', description: 'Мои записи' }, { command: 'start', description: 'Главное меню' }] });
      const me = await tg(env, 'getMe', {});
      return Response.json({ webhook: hook.ok, commands: cmds.ok, bot: me.result?.username, link: me.result ? `https://t.me/${me.result.username}?start=book` : null });
    }
    if (url.pathname === '/book') {
      const me = await tg(env, 'getMe', {});
      if (me.result?.username) return Response.redirect(`https://t.me/${me.result.username}?start=book`, 302);
    }
    return new Response('ТехноМоторика — бот записи работает.');
  },

  async scheduled(event, env) {
    if (event.cron === '0 9 * * *') await remindTomorrow(env);   // 12:00 МСК
    if (event.cron === '0 6 * * *') await morningDigest(env);    // 09:00 МСК
  },
};
