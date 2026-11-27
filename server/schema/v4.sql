CREATE TABLE source_account (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  uid TEXT NOT NULL CHECK(length(uid) BETWEEN 1 AND 30 AND uid NOT GLOB '*[^0-9]*'),
  nickname TEXT NOT NULL
) STRICT;
