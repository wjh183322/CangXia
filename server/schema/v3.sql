CREATE TABLE interactive_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  boot_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  holder TEXT CHECK(holder IS NULL OR json_valid(holder))
) STRICT;
CREATE TABLE command_receipts (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
CREATE TABLE entity_versions (
  entity TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT;
