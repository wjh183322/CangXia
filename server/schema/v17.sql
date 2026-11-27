-- Approved download batches bind the exact selected IDs to resource and queue versions.
-- Versions survive deletion so reusing an ID cannot revive old consent.
CREATE TABLE download_work_versions(work_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1) STRICT;
INSERT INTO download_work_versions SELECT id,1 FROM works;
CREATE TABLE download_batches(id TEXT PRIMARY KEY, account TEXT NOT NULL, scope TEXT NOT NULL,
 selection TEXT NOT NULL CHECK(json_valid(selection)), auth TEXT NOT NULL CHECK(json_valid(auth)),
 total INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL) STRICT;
CREATE TABLE download_batch_items(batch TEXT NOT NULL REFERENCES download_batches(id), work_id TEXT NOT NULL,
 version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', reason TEXT,
 PRIMARY KEY(batch,work_id)) STRICT;
CREATE INDEX download_batch_dispatch ON download_batch_items(batch,state);
CREATE INDEX download_batch_state ON download_batches(state);
CREATE TRIGGER download_version_works_insert AFTER INSERT ON works BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_works_update AFTER UPDATE OF body,title ON works BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_works_delete AFTER DELETE ON works BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_source_audio_hints_insert AFTER INSERT ON source_audio_hints BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
 UPDATE catalogue_version SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER download_version_source_audio_hints_update AFTER UPDATE ON source_audio_hints BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
 UPDATE catalogue_version SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER download_version_source_audio_hints_delete AFTER DELETE ON source_audio_hints BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
 UPDATE catalogue_version SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER download_version_download_jobs_insert AFTER INSERT ON download_jobs BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_download_jobs_update AFTER UPDATE OF state ON download_jobs WHEN OLD.state<>NEW.state BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_download_jobs_delete AFTER DELETE ON download_jobs BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_media_files_insert AFTER INSERT ON media_files BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_media_files_update AFTER UPDATE ON media_files BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_media_files_delete AFTER DELETE ON media_files BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_archive_assets_insert AFTER INSERT ON archive_assets BEGIN
 INSERT INTO download_work_versions(work_id) SELECT work_id FROM media_files WHERE id=NEW.id ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_archive_assets_update AFTER UPDATE ON archive_assets BEGIN
 INSERT INTO download_work_versions(work_id) SELECT work_id FROM media_files WHERE id=NEW.id ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_archive_assets_delete AFTER DELETE ON archive_assets BEGIN
 INSERT INTO download_work_versions(work_id) SELECT work_id FROM media_files WHERE id=OLD.id ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_maintenance_file_state_insert AFTER INSERT ON maintenance_file_state BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_maintenance_file_state_update AFTER UPDATE ON maintenance_file_state BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_maintenance_file_state_delete AFTER DELETE ON maintenance_file_state BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_file_commits_insert AFTER INSERT ON file_commits WHEN NEW.stage='registered' BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
 UPDATE catalogue_version SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER download_version_file_commits_update AFTER UPDATE ON file_commits WHEN NEW.stage='registered' OR OLD.stage='registered' BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
 UPDATE catalogue_version SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER download_version_file_commits_delete AFTER DELETE ON file_commits WHEN OLD.stage='registered' BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
 UPDATE catalogue_version SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER download_version_removed_work_records_insert AFTER INSERT ON removed_work_records BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_removed_work_records_update AFTER UPDATE ON removed_work_records BEGIN
 INSERT INTO download_work_versions(work_id) SELECT NEW.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER download_version_removed_work_records_delete AFTER DELETE ON removed_work_records BEGIN
 INSERT INTO download_work_versions(work_id) SELECT OLD.work_id WHERE true ON CONFLICT(work_id) DO UPDATE SET revision=revision+1;
END;
