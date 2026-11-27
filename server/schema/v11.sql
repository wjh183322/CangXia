CREATE TABLE archive_state(
 work_id TEXT PRIMARY KEY REFERENCES works(id), revision INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, error TEXT
) STRICT;
-- Opening an upgraded volume is not a request to reorganize every existing home.
INSERT INTO archive_state(work_id,revision,completed) SELECT work_id,1,1 FROM archive_homes;
INSERT INTO archive_state(work_id,revision) SELECT DISTINCT work_id,1 FROM read_finalizers WHERE status='pending' AND work_id IN (SELECT id FROM works)
 ON CONFLICT(work_id) DO UPDATE SET completed=0;
CREATE TABLE hd_covers(work_id TEXT PRIMARY KEY REFERENCES works(id), video_sha TEXT NOT NULL, cover_sha TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
CREATE TRIGGER archive_dirty_work AFTER UPDATE OF title,body ON works WHEN NEW.title<>OLD.title OR NEW.body<>OLD.body BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes WHERE work_id=NEW.id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_dirty_tag_add AFTER INSERT ON work_tags BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes WHERE work_id=NEW.work_id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_dirty_tag_remove AFTER DELETE ON work_tags BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes WHERE work_id=OLD.work_id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_dirty_member_add AFTER INSERT ON source_members BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes WHERE work_id=NEW.work_id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_dirty_member_remove AFTER DELETE ON source_members BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes WHERE work_id=OLD.work_id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_dirty_source AFTER UPDATE OF name,added,missing,body ON read_sources WHEN NEW.name<>OLD.name OR NEW.added<>OLD.added OR NEW.missing<>OLD.missing OR NEW.body<>OLD.body BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes WHERE work_id IN (SELECT work_id FROM source_members WHERE source_id=NEW.source_id) OR 'folder:'||json_extract(body,'$.home.id')=NEW.source_id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_finalizer_insert AFTER INSERT ON read_finalizers BEGIN
 INSERT INTO archive_state(work_id,revision) VALUES(NEW.work_id,1) ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
CREATE TRIGGER archive_finalizer_update AFTER UPDATE OF operation_id ON read_finalizers BEGIN
 INSERT INTO archive_state(work_id,revision) VALUES(NEW.work_id,1) ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
