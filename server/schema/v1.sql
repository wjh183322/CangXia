-- First formal storage format. Probe and desktop databases have different identities.
CREATE TABLE library_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  app_id TEXT NOT NULL,
  library_id TEXT NOT NULL
) STRICT;
CREATE TABLE works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
CREATE TABLE work_tags (
  work_id TEXT NOT NULL REFERENCES works(id),
  tag TEXT NOT NULL,
  PRIMARY KEY(work_id, tag)
) STRICT;
CREATE TABLE source_members (
  source_id TEXT NOT NULL,
  work_id TEXT NOT NULL REFERENCES works(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(source_id, work_id)
) STRICT;
CREATE TABLE download_jobs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  state TEXT NOT NULL
) STRICT;
CREATE TABLE media_files (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;
