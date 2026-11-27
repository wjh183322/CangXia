CREATE TABLE download_options (
 id INTEGER PRIMARY KEY CHECK(id=1), concurrency INTEGER NOT NULL CHECK(concurrency BETWEEN 1 AND 6),
 paused INTEGER NOT NULL, revision INTEGER NOT NULL, auth_epoch INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO download_options VALUES(1,3,0,0,0);
CREATE TABLE download_manifests (
 id TEXT PRIMARY KEY REFERENCES download_jobs(id), work_id TEXT NOT NULL REFERENCES works(id),
 body TEXT NOT NULL CHECK(json_valid(body)), hidden INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE archive_homes (work_id TEXT PRIMARY KEY REFERENCES works(id), body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
CREATE TABLE archive_assets (
 id TEXT PRIMARY KEY REFERENCES media_files(id), key TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, revision INTEGER NOT NULL
) STRICT;
CREATE VIEW archive_resources AS SELECT m.*,a.key,a.kind,a.mime,a.revision,'complete' AS state
 FROM archive_assets a JOIN media_files m ON m.id=a.id;
CREATE TABLE file_commits (
 id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), resource_id TEXT,
 stage TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),revision INTEGER NOT NULL
) STRICT;
CREATE INDEX file_commits_by_work ON file_commits(work_id,resource_id,stage);
CREATE TABLE download_auth (id INTEGER PRIMARY KEY CHECK(id=1), session_key TEXT NOT NULL) STRICT;
CREATE TRIGGER download_auth_insert AFTER INSERT ON download_auth BEGIN UPDATE download_options SET auth_epoch=auth_epoch+1; END;
CREATE TRIGGER download_auth_changed AFTER UPDATE OF session_key ON download_auth WHEN NEW.session_key<>OLD.session_key BEGIN UPDATE download_options SET auth_epoch=auth_epoch+1; END;
CREATE TRIGGER download_auth_deleted AFTER DELETE ON download_auth BEGIN UPDATE download_options SET auth_epoch=auth_epoch+1; END;
CREATE TRIGGER download_logout AFTER UPDATE OF profile_id ON source_account WHEN NEW.profile_id IS NULL
 BEGIN DELETE FROM download_auth; END;
DROP TRIGGER catalogue_download_jobs_update;
CREATE TRIGGER catalogue_download_jobs_update AFTER UPDATE OF state ON download_jobs
 WHEN OLD.state<>NEW.state BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
