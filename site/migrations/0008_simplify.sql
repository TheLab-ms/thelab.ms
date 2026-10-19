-- Membership sync no longer uses a Durable Object or nightly repair, sessions
-- are keyed by Discord account, and every access change pushes the fob list.
DROP INDEX members_sync_repair;
ALTER TABLE members DROP COLUMN sync_repair_at;
ALTER TABLE members DROP COLUMN auth_version;
ALTER TABLE members DROP COLUMN stripe_synced_at;
ALTER TABLE members DROP COLUMN discord_last_synced;
ALTER TABLE edge_changes DROP COLUMN pushed;
