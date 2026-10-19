-- The Worker pushes the authorized fob list when this revision changes and
-- records the last revision the edge accepted. sync_requested globally rate
-- limits the edge's unauthenticated requests for a fresh push.
ALTER TABLE edge_changes ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE edge_changes ADD COLUMN sync_requested INTEGER NOT NULL DEFAULT 0;
