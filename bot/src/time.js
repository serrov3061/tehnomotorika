import { TZ_OFFSET_MIN, OPEN_HOUR, CELL_MIN, CELLS, CLOSED_WEEKDAYS, DAYS_AHEAD, MIN_LEAD_MIN } from './config.js';

const WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WD_LONG = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const pad = (n) => String(n).padStart(2, '0');

/** «Сейчас» по Москве. Читать только через getUTC*. */
export function mskNow(nowMs = Date.now()) {
  return new Date(nowMs + TZ_OFFSET_MIN * 60000);
}

export function dayKey(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export function parseDay(key) {
  return new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8)));
}

export function addDays(key, n) {
  const d = parseDay(key);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}

export function todayKey(nowMs) {
  return dayKey(mskNow(nowMs));
}

export function isClosed(key) {
  return CLOSED_WEEKDAYS.includes(parseDay(key).getUTCDay());
}

export function isValidDay(key) {
  return /^\d{8}$/.test(key) && dayKey(parseDay(key)) === key;
}

/** «Пт 14.11» — для кнопок. */
export function dayShort(key) {
  const d = parseDay(key);
  return `${WD_SHORT[d.getUTCDay()]} ${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}`;
}

/** «пятница, 14 ноября» — для текста. */
export function dayLong(key) {
  const d = parseDay(key);
  return `${WD_LONG[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function cellTime(cell) {
  const m = OPEN_HOUR * 60 + cell * CELL_MIN;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function rangeText(start, len) {
  return `${cellTime(start)}–${cellTime(start + len)}`;
}

export function durationText(len) {
  const min = len * CELL_MIN;
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h} ч ${m} мин` : h ? `${h} ч` : `${m} мин`;
}

/** Первая ячейка, на которую ещё можно записаться в этот день. */
export function firstOpenCell(key, nowMs) {
  const today = todayKey(nowMs);
  if (key > today) return 0;
  if (key < today) return CELLS; // прошлое — ничего
  const n = mskNow(nowMs);
  const nowMin = n.getUTCHours() * 60 + n.getUTCMinutes() + MIN_LEAD_MIN;
  return Math.max(0, Math.ceil((nowMin - OPEN_HOUR * 60) / CELL_MIN));
}

/** Свободные стартовые ячейки для услуги длиной len. */
export function freeStarts(busy, len, minCell = 0) {
  const out = [];
  for (let c = Math.max(0, minCell); c + len <= CELLS; c++) {
    let ok = true;
    for (let k = c; k < c + len; k++) if (busy.has(k)) { ok = false; break; }
    if (ok) out.push(c);
  }
  return out;
}

/** Рабочие дни в окне записи. */
export function bookableDays(nowMs) {
  const out = [];
  const start = todayKey(nowMs);
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const k = addDays(start, i);
    if (!isClosed(k)) out.push(k);
  }
  return out;
}

/** Запись ещё не началась? */
export function isUpcoming(key, startCell, nowMs) {
  const today = todayKey(nowMs);
  if (key !== today) return key > today;
  const n = mskNow(nowMs);
  const nowMin = n.getUTCHours() * 60 + n.getUTCMinutes();
  return OPEN_HOUR * 60 + startCell * CELL_MIN > nowMin;
}
