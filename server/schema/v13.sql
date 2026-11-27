CREATE TRIGGER catalogue_archive_assets_insert AFTER INSERT ON archive_assets
BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_archive_assets_update AFTER UPDATE ON archive_assets
WHEN (OLD.id,OLD.key,OLD.kind,OLD.mime,OLD.revision) IS NOT (NEW.id,NEW.key,NEW.kind,NEW.mime,NEW.revision)
BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER catalogue_archive_assets_delete AFTER DELETE ON archive_assets
BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
