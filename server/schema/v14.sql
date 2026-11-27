CREATE TABLE removal_batches(
 token TEXT PRIMARY KEY, account TEXT NOT NULL, scope TEXT NOT NULL,
 revision INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
CREATE TABLE removal_items(
 token TEXT NOT NULL REFERENCES removal_batches(token), ordinal INTEGER NOT NULL,
 work_id TEXT NOT NULL REFERENCES works(id), state TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(token,ordinal)
) STRICT;
CREATE INDEX removal_item_work ON removal_items(work_id,state);
CREATE TABLE removed_work_records(work_id TEXT PRIMARY KEY REFERENCES works(id), token TEXT NOT NULL REFERENCES removal_batches(token)) STRICT;
CREATE TRIGGER removed_work_add AFTER INSERT ON removed_work_records BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER removed_work_restore AFTER DELETE ON removed_work_records BEGIN UPDATE catalogue_version SET revision=revision+1 WHERE id=1; END;
CREATE TABLE trash_probe(singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
