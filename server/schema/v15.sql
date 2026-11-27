CREATE TABLE maintenance_runs (
 id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
 created INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, reason TEXT, totals TEXT CHECK(json_valid(totals))
) STRICT;
CREATE TABLE maintenance_items (
 run TEXT NOT NULL REFERENCES maintenance_runs(id), ordinal INTEGER NOT NULL, work_id TEXT NOT NULL,
 result TEXT CHECK(json_valid(result)), PRIMARY KEY(run,ordinal), UNIQUE(run,work_id)
) STRICT;
CREATE INDEX maintenance_work ON maintenance_items(work_id,run);
CREATE TABLE maintenance_cover_failures(work_id TEXT PRIMARY KEY REFERENCES works(id)) STRICT;
CREATE TABLE maintenance_queue_links (
 run TEXT NOT NULL, work_id TEXT NOT NULL, job TEXT NOT NULL,
 PRIMARY KEY(run,work_id), FOREIGN KEY(run,work_id) REFERENCES maintenance_items(run,work_id)
) STRICT;
CREATE INDEX maintenance_queue_job ON maintenance_queue_links(job);
CREATE TABLE maintenance_file_state(work_id TEXT PRIMARY KEY REFERENCES works(id), status TEXT NOT NULL CHECK(status IN ('partial','checking'))) STRICT;
CREATE TRIGGER maintenance_file_add AFTER INSERT ON maintenance_file_state BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER maintenance_file_update AFTER UPDATE ON maintenance_file_state WHEN OLD.status<>NEW.status BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER maintenance_file_clear AFTER DELETE ON maintenance_file_state BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
