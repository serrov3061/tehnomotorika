// Всё, что владелец может захотеть поменять, — здесь.

export const TZ_OFFSET_MIN = 180;      // Москва, UTC+3
export const OPEN_HOUR = 10;           // начало приёма
export const CLOSE_HOUR = 21;          // к этому времени работа должна закончиться
export const CELL_MIN = 30;            // шаг сетки, минут
export const CELLS = ((CLOSE_HOUR - OPEN_HOUR) * 60) / CELL_MIN; // 22 ячейки
export const CLOSED_WEEKDAYS = [0];    // 0 = воскресенье
export const DAYS_AHEAD = 14;          // на сколько дней вперёд можно записаться
export const MIN_LEAD_MIN = 60;        // запись на сегодня — не раньше чем через час
export const MAX_ACTIVE_PER_CLIENT = 2; // защита от «занять всё»

// len — длительность в ячейках по 30 минут (2 = 1 час).
export const SERVICES = [
  { id: 'to',    name: 'Плановое ТО',                 price: '5 000 ₽',  len: 4 },
  { id: 'oil',   name: 'Замена масла',                price: '3 000 ₽',  len: 2 },
  { id: 'padf',  name: 'Колодки передние',  price: '3 500 ₽',  len: 2 },
  { id: 'padr',  name: 'Колодки задние',    price: '3 500 ₽',  len: 2 },
  { id: 'ac',    name: 'Заправка кондиционера',       price: '6 000 ₽',  len: 2 },
  { id: 'cdiag', name: 'Компьютерная диагностика',    price: '3 000 ₽',  len: 2 },
  { id: 'sdiag', name: 'Диагностика ходовой',         price: '3 000 ₽',  len: 2 },
  { id: 'fdiag', name: 'Комплексная диагностика',     price: '10 000 ₽', len: 4 },
  { id: 'align', name: 'Развал-схождение',            price: '4 000 ₽',  len: 2 },
  { id: 'insp',  name: 'Осмотр и оценка ремонта',     price: '',         len: 2,
    hint: 'двигатель, АКПП, кузов, выхлоп, пневмоподвеска, впуск' },
];

export const CONTACTS = {
  phone: '+7 985 444-70-63',
  hours: 'Пн–Сб 10:00–21:00',
  site: 'https://tehnomotorika.vercel.app',
  map: 'https://yandex.ru/maps/?text=%D0%A2%D0%B5%D1%85%D0%BD%D0%BE%D0%9C%D0%BE%D1%82%D0%BE%D1%80%D0%B8%D0%BA%D0%B0%20%D0%B0%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81',
};

// Профиль бота: «О боте» (до 120 символов) и экран до нажатия «Запустить» (до 512)
export const BOT_SHORT = 'Онлайн-запись в ТехноМоторику — сервис BMW и Mercedes-Benz. Пн–Сб 10:00–21:00, +7 985 444-70-63';
export const BOT_DESCRIPTION = `Запись в ТехноМоторику — обслуживание и ремонт BMW и Mercedes-Benz.

• Выберите услугу, день и свободное время — запись подтверждается сразу
• Время, которое уже заняли, не показывается — накладок не будет
• Накануне пришлём напоминание
• Отменить или посмотреть запись можно здесь же

Пн–Сб 10:00–21:00
+7 985 444-70-63

Нажмите «Запустить» — запись займёт минуту.`;
