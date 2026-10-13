-- Only a fair sweep cursor; authoritative pending/error state lives in the DO.
ALTER TABLE members ADD COLUMN sync_repair_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX members_sync_repair ON members(sync_repair_at, member_id);
