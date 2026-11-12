-- ТехноМоторика: онлайн-запись
-- Время делится на ячейки по 30 минут (ячейка 0 = 10:00).
-- Каждая запись занимает несколько ячеек. PRIMARY KEY (day, cell) в таблице cells
-- не даёт двум записям занять одну и ту же ячейку: вторая вставка падает,
-- и вся транзакция откатывается. Это и есть гарантия «слот нельзя перебить».

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL DEFAULT 'client',   -- 'client' | 'block' (время закрыто владельцем)
  user_id     INTEGER,
  name        TEXT,
  phone       TEXT,
  car         TEXT,
  service     TEXT,
  day         TEXT    NOT NULL,                    -- 'YYYYMMDD', московское время
  start       INTEGER NOT NULL,                    -- номер первой ячейки
  len         INTEGER NOT NULL,                    -- сколько ячеек занимает
  status      TEXT    NOT NULL DEFAULT 'active',   -- 'active' | 'cancelled'
  reminded    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS bookings_day  ON bookings(day, status);
CREATE INDEX IF NOT EXISTS bookings_user ON bookings(user_id, status);

CREATE TABLE IF NOT EXISTS cells (
  day        TEXT    NOT NULL,
  cell       INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  PRIMARY KEY (day, cell)
);
CREATE INDEX IF NOT EXISTS cells_booking ON cells(booking_id);

CREATE TABLE IF NOT EXISTS clients (
  user_id INTEGER PRIMARY KEY,
  name    TEXT,
  phone   TEXT,
  car     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  user_id    INTEGER PRIMARY KEY,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY
);
