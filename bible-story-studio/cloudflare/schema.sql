-- D1 series-memory schema for Bible Videos for Kids
-- Apply: npx wrangler d1 execute bible-videos-series-memory --file schema.sql --remote

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  source          TEXT,
  lesson          TEXT,
  topic           TEXT,
  status          TEXT    DEFAULT 'assembled',
  youtube_id      TEXT,
  youtube_url     TEXT,
  youtube_privacy TEXT,
  episode_mp4_key TEXT,
  thumbnail_key   TEXT,
  created_at      INTEGER DEFAULT (unixepoch()),
  published_at    INTEGER
);

CREATE TABLE IF NOT EXISTS characters (
  id                  TEXT    PRIMARY KEY,
  name                TEXT    NOT NULL UNIQUE,
  description         TEXT,
  palette_skin        TEXT,
  palette_hair        TEXT,
  palette_robe        TEXT,
  reference_sheet_key TEXT,
  created_at          INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS episode_characters (
  episode_id   TEXT REFERENCES episodes(id),
  character_id TEXT REFERENCES characters(id),
  PRIMARY KEY (episode_id, character_id)
);

CREATE TABLE IF NOT EXISTS topics_queue (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  topic    TEXT    UNIQUE NOT NULL,
  priority INTEGER DEFAULT 5,
  used     INTEGER DEFAULT 0,
  used_at  INTEGER
);

-- Feature 6: Cost ledger — tracks spend per stage per episode
CREATE TABLE IF NOT EXISTS costs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id  TEXT    NOT NULL,
  stage       TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  units       REAL    NOT NULL,
  unit_type   TEXT    NOT NULL,
  rate_usd    REAL    NOT NULL,
  total_usd   REAL    NOT NULL,
  recorded_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS costs_episode_idx ON costs(episode_id);
CREATE INDEX IF NOT EXISTS costs_recorded_idx ON costs(recorded_at);

-- Seed topics (already applied; safe to re-run due to INSERT OR IGNORE)
INSERT OR IGNORE INTO topics_queue (topic, priority) VALUES
  ('Noah and the Great Flood',                    10),
  ('David and Goliath',                           10),
  ('The Birth of Jesus',                          10),
  ('Moses Parts the Red Sea',                     10),
  ('Jonah and the Big Fish',                      10),
  ('Daniel in the Lions Den',                      9),
  ('Joseph and His Colorful Coat',                 9),
  ('The Feeding of Five Thousand',                 9),
  ('The Good Samaritan',                           9),
  ('The Prodigal Son',                             9),
  ('Adam and Eve in the Garden of Eden',           8),
  ('The Tower of Babel',                           8),
  ('Abraham and God''s Promise of Stars',          8),
  ('The Burning Bush Calls Moses',                 8),
  ('Elijah and the Fiery Chariot',                 8),
  ('Ruth and Naomi''s Faithful Journey',           8),
  ('Esther Saves Her People',                      8),
  ('The Three Friends in the Fiery Furnace',       8),
  ('Jesus Walks on Water',                         8),
  ('Zacchaeus Climbs a Tree to See Jesus',         7);
