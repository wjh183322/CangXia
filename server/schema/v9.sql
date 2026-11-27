CREATE TABLE catalogue_version (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL) STRICT;
INSERT INTO catalogue_version VALUES(1,0);
CREATE INDEX catalogue_work_sources ON source_members(work_id,source_id);
CREATE INDEX catalogue_media_work ON media_files(work_id);
CREATE INDEX catalogue_work_type ON works(json_extract(body,'$.type'));
CREATE INDEX catalogue_tag ON work_tags(tag,work_id);
CREATE VIEW catalogue_people_input AS SELECT w.id AS work_id, p.value AS person FROM works w, json_each(json_insert(coalesce(json_extract(w.body,'$.coAuthors'),'[]'),'$[#]',json(coalesce(json_extract(w.body,'$.author'),'{}')))) p;
CREATE TABLE catalogue_people (work_id TEXT NOT NULL,person TEXT NOT NULL CHECK(json_valid(person))) STRICT;
CREATE INDEX catalogue_people_work ON catalogue_people(work_id);
INSERT INTO catalogue_people SELECT * FROM catalogue_people_input;
CREATE TRIGGER catalogue_people_insert AFTER INSERT ON works BEGIN
 DELETE FROM catalogue_people WHERE work_id=NEW.id;
 INSERT INTO catalogue_people SELECT * FROM catalogue_people_input WHERE work_id=NEW.id;
END;
CREATE TRIGGER catalogue_people_update AFTER UPDATE OF body ON works BEGIN
 DELETE FROM catalogue_people WHERE work_id=OLD.id;
 INSERT INTO catalogue_people SELECT * FROM catalogue_people_input WHERE work_id=NEW.id;
END;
CREATE TRIGGER catalogue_people_delete AFTER DELETE ON works BEGIN DELETE FROM catalogue_people WHERE work_id=OLD.id; END;
CREATE TRIGGER catalogue_works_insert AFTER INSERT ON works BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_works_update AFTER UPDATE ON works BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_works_delete AFTER DELETE ON works BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_source_members_insert AFTER INSERT ON source_members BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_source_members_update AFTER UPDATE ON source_members BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_source_members_delete AFTER DELETE ON source_members BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_work_tags_insert AFTER INSERT ON work_tags BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_work_tags_update AFTER UPDATE ON work_tags BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_work_tags_delete AFTER DELETE ON work_tags BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_source_creator_profiles_insert AFTER INSERT ON source_creator_profiles BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_source_creator_profiles_update AFTER UPDATE ON source_creator_profiles BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_source_creator_profiles_delete AFTER DELETE ON source_creator_profiles BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_media_files_insert AFTER INSERT ON media_files BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_media_files_update AFTER UPDATE ON media_files BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_media_files_delete AFTER DELETE ON media_files BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;

CREATE INDEX catalogue_download_state ON download_jobs(work_id,state);
CREATE TRIGGER catalogue_download_jobs_insert AFTER INSERT ON download_jobs BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_download_jobs_update AFTER UPDATE ON download_jobs BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_download_jobs_delete AFTER DELETE ON download_jobs BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
