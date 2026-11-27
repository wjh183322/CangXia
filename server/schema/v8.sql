-- Counts from earlier reads were not recorded and cannot be reconstructed
-- from today's memberships. NULL retains that distinction in old logs.
ALTER TABLE read_batches ADD COLUMN selected_step TEXT;
ALTER TABLE read_steps ADD COLUMN history_count INTEGER;
