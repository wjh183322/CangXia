DROP TRIGGER archive_dirty_source;
CREATE TRIGGER archive_dirty_source AFTER UPDATE OF name,added,missing,body ON read_sources
 WHEN NEW.name<>OLD.name OR NEW.added<>OLD.added OR NEW.missing<>OLD.missing
 OR json_extract(NEW.body,'$.folder') IS NOT json_extract(OLD.body,'$.folder')
 BEGIN
 INSERT INTO archive_state(work_id,revision) SELECT work_id,1 FROM archive_homes
 WHERE work_id IN (SELECT work_id FROM source_members WHERE source_id=NEW.source_id)
 OR json_extract(body,'$.home.kind')='collection' AND 'folder:'||json_extract(body,'$.home.id')=NEW.source_id
 OR json_extract(body,'$.home.kind')='author' AND 'author:'||json_extract(body,'$.home.id')=NEW.source_id
 ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error=NULL;
END;
