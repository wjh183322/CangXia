-- A higher order generation places a newly read prefix before the untouched suffix.
ALTER TABLE source_members ADD COLUMN order_generation INTEGER NOT NULL DEFAULT 0;
CREATE INDEX source_members_order ON source_members(source_id, order_generation DESC, position, work_id);
CREATE TABLE membership_removals (
  source_id TEXT NOT NULL,
  work_id TEXT NOT NULL REFERENCES works(id),
  revision INTEGER NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  PRIMARY KEY(source_id,work_id)
) STRICT;
CREATE TABLE source_read_runs (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  job_epoch INTEGER NOT NULL,
  auth_epoch TEXT NOT NULL,
  uid TEXT NOT NULL,
  source_id TEXT NOT NULL,
  active INTEGER NOT NULL,
  cursor TEXT,
  received INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX current_source_read ON source_read_runs(source_id) WHERE active=1;
CREATE TABLE source_read_items (
  job_id TEXT NOT NULL REFERENCES source_read_runs(job_id),
  work_id TEXT NOT NULL REFERENCES works(id),
  baseline INTEGER,
  observed INTEGER,
  PRIMARY KEY(job_id,work_id)
) STRICT;
CREATE TABLE source_page_operations (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES source_read_runs(job_id),
  job_epoch INTEGER NOT NULL,
  auth_epoch TEXT NOT NULL,
  input_cursor TEXT NOT NULL,
  removal_revision INTEGER NOT NULL,
  digest TEXT,
  received_count INTEGER,
  ordered_refs TEXT CHECK(ordered_refs IS NULL OR json_valid(ordered_refs)),
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  abandoned INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX source_pending_or_committed_cursor ON source_page_operations(job_id,input_cursor) WHERE abandoned=0;
CREATE TABLE membership_restorations (
  job_id TEXT NOT NULL REFERENCES source_read_runs(job_id),
  source_id TEXT NOT NULL,
  work_id TEXT NOT NULL REFERENCES works(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(job_id,work_id)
) STRICT;
CREATE TABLE source_creator_profiles (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
CREATE INDEX source_creator_sec ON source_creator_profiles(json_extract(body,'$.secUid'));
CREATE TABLE source_audio_hints (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
