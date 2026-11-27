CREATE TABLE read_sources (
  source_id TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
  added INTEGER NOT NULL, missing INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE read_batches (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, auth_epoch TEXT NOT NULL, owner_boot TEXT NOT NULL, owner_generation INTEGER NOT NULL,
  status TEXT NOT NULL, started TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX single_reader ON read_batches(status) WHERE status='running';
CREATE TABLE read_steps (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES read_batches(id), ordinal INTEGER NOT NULL,
  source_id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
  resume_folder INTEGER NOT NULL DEFAULT 0, goal INTEGER, outcome TEXT, superseded INTEGER NOT NULL DEFAULT 0, baseline_known INTEGER NOT NULL DEFAULT 0, anchor_run TEXT,
  streak INTEGER NOT NULL DEFAULT 0, streak_pages INTEGER NOT NULL DEFAULT 0, last_anchor INTEGER,
  empty_pages INTEGER NOT NULL DEFAULT 0, UNIQUE(batch_id,ordinal)
) STRICT;
CREATE INDEX read_steps_source ON read_steps(source_id,mode);
CREATE TABLE read_prior_batches (
  batch_id TEXT NOT NULL REFERENCES read_batches(id), run_id TEXT NOT NULL REFERENCES read_steps(id),
  ordinal INTEGER NOT NULL, PRIMARY KEY(batch_id,run_id)
) STRICT;
CREATE VIEW read_history_steps AS
  SELECT s.*,s.batch_id AS history_batch,s.ordinal AS history_position FROM read_steps s
  UNION ALL SELECT s.*,h.batch_id,h.ordinal FROM read_prior_batches h JOIN read_steps s ON s.id=h.run_id;
CREATE TABLE read_differences (
  run_id TEXT NOT NULL REFERENCES read_steps(id), work_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
  kind TEXT NOT NULL, new_work INTEGER NOT NULL, PRIMARY KEY(run_id,work_id)
) STRICT;
CREATE TABLE read_finalizers (
  run_id TEXT NOT NULL REFERENCES read_steps(id), work_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  PRIMARY KEY(run_id,work_id)
) STRICT;
CREATE TABLE read_page_buffers (
  run_id TEXT PRIMARY KEY REFERENCES read_steps(id), cursor TEXT NOT NULL, offset INTEGER NOT NULL,
  removal_revision INTEGER NOT NULL, page TEXT NOT NULL CHECK(json_valid(page))
) STRICT;
-- Populated from actual backup logs by an approved migration.
CREATE TABLE read_legacy_runs (
  id TEXT PRIMARY KEY, started TEXT, summary TEXT NOT NULL CHECK(json_valid(summary))
) STRICT;
CREATE TABLE read_legacy_items (
  run_id TEXT NOT NULL REFERENCES read_legacy_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
  PRIMARY KEY(run_id,kind,position)
) STRICT;
CREATE TABLE read_anchors (
  run_id TEXT NOT NULL REFERENCES read_steps(id), work_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(run_id,work_id)
) STRICT;
