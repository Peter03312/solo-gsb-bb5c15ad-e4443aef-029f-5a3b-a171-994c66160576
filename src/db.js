'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'cueboard.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sm', 'operator')),
  position   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 当前可编辑草稿（全局只有一份）
CREATE TABLE IF NOT EXISTS draft_cues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  position   TEXT NOT NULL,
  planned_start INTEGER NOT NULL,   -- 当日 00:00 起的分钟数
  duration   INTEGER NOT NULL,      -- 分钟
  row_ver    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(code)
);

CREATE TABLE IF NOT EXISTS draft_deps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_cue  INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  to_cue    INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  UNIQUE(from_cue, to_cue)
);

-- 已发布的只读联排版本
CREATE TABLE IF NOT EXISTS rehearsal_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no INTEGER NOT NULL UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS published_cues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id      INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref         INTEGER NOT NULL,          -- 指向当时的 draft cue id
  code            TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  position        TEXT NOT NULL,
  planned_start   INTEGER NOT NULL,
  duration        INTEGER NOT NULL,
  UNIQUE(version_id, cue_ref)
);

CREATE TABLE IF NOT EXISTS published_deps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  from_ref    INTEGER NOT NULL,
  to_ref      INTEGER NOT NULL,
  UNIQUE(version_id, from_ref, to_ref)
);

-- 现场登记（每个已发布提示项一行，随发布创建）
CREATE TABLE IF NOT EXISTS registrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,
  position       TEXT NOT NULL,
  actual_start   INTEGER,                   -- 实际开始（分钟）
  actual_end     INTEGER,                   -- 实际完成（分钟）
  estimated_end  INTEGER,                   -- 预计结束（分钟）
  skipped        INTEGER NOT NULL DEFAULT 0,-- 1：舞监已将该项标记为跳过（依赖链不可执行）
  row_ver        INTEGER NOT NULL DEFAULT 1,
  updated_by     TEXT,
  updated_at     TEXT,
  source_version_id INTEGER,                -- 发布交接：实际时间延续自哪个旧执行版
  source_cue_ref    INTEGER,                -- 发布交接：延续自旧版的哪个提示项引用
  UNIQUE(version_id, cue_ref)
);

-- 依赖链跳过留痕：每个版本每项至多一条（已跳过项再次出现在链中只展示、不重复留痕）
CREATE TABLE IF NOT EXISTS registration_skips (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,          -- 被跳过的提示项引用
  root_cue_ref   INTEGER NOT NULL,          -- 触发本次操作的根提示项（沿其后继传播）
  reason         TEXT NOT NULL,             -- 非空原因
  skipped_by     TEXT NOT NULL,             -- 操作者（舞监）
  skipped_at     TEXT NOT NULL,             -- 操作时间
  UNIQUE(version_id, cue_ref)
);

-- 舞监现场登记更正历史（一次更正可能产生级联两条）
CREATE TABLE IF NOT EXISTS registration_corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,
  field          TEXT NOT NULL CHECK (field IN ('actual_start', 'actual_end', 'estimated_end')),
  old_value      INTEGER,                   -- 更正前（分钟），NULL 表示原本未登记
  new_value      INTEGER,                   -- 更正后（分钟），NULL 表示清除
  reason         TEXT NOT NULL,
  cascaded       INTEGER NOT NULL DEFAULT 0,-- 1：清除开始时级联清除完成
  group_id       INTEGER,                   -- 同一次更正：级联行指向主行 id；主行为 NULL（排序用 COALESCE）
  corrected_by   TEXT NOT NULL,
  corrected_at   TEXT NOT NULL
);

-- 岗位代班：现场临时换人（按版本记录，启用/撤销均留痕，旧版只读可查）
CREATE TABLE IF NOT EXISTS position_deputies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  position       TEXT NOT NULL,
  deputy_user_id INTEGER NOT NULL REFERENCES users(id),
  deputy_username     TEXT NOT NULL,   -- 冗余保存账号与姓名，账号后续变化不影响历史展示
  deputy_display_name TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,  -- 1 在任；0 已撤销
  enabled_by     TEXT NOT NULL,
  enabled_at     TEXT NOT NULL,
  revoked_by     TEXT,
  revoked_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pcues_version ON published_cues(version_id);
CREATE INDEX IF NOT EXISTS idx_reg_version ON registrations(version_id);
CREATE INDEX IF NOT EXISTS idx_corr_version ON registration_corrections(version_id);
CREATE INDEX IF NOT EXISTS idx_deputies_version ON position_deputies(version_id);
CREATE INDEX IF NOT EXISTS idx_skips_version ON registration_skips(version_id);
-- 每个版本每个岗位至多一名在任代班（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_deputies_active
  ON position_deputies(version_id, position) WHERE active = 1;
`);

// 幂等迁移：旧库的 registrations 表没有交接来源列时补齐（CREATE TABLE IF NOT EXISTS 不会改既有表）
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}
ensureColumn('registrations', 'source_version_id',
  'ALTER TABLE registrations ADD COLUMN source_version_id INTEGER');
ensureColumn('registrations', 'source_cue_ref',
  'ALTER TABLE registrations ADD COLUMN source_cue_ref INTEGER');
ensureColumn('registrations', 'skipped',
  'ALTER TABLE registrations ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');

function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

module.exports = { db, getMeta, setMeta, DB_PATH };
