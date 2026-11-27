ALTER TABLE maintenance_queue_links RENAME TO maintenance_queue_v15;
DROP INDEX maintenance_queue_job;
CREATE TABLE maintenance_queue_links (
 run TEXT NOT NULL,work_id TEXT NOT NULL,job TEXT NOT NULL,
 PRIMARY KEY(run,work_id,job), FOREIGN KEY(run,work_id) REFERENCES maintenance_items(run,work_id)
) STRICT;
INSERT INTO maintenance_queue_links SELECT run,work_id,job FROM maintenance_queue_v15;
DROP TABLE maintenance_queue_v15;
CREATE INDEX maintenance_queue_job ON maintenance_queue_links(job);
ALTER TABLE maintenance_cover_failures ADD COLUMN version TEXT;
