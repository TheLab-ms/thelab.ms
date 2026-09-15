-- Conway's signed-waiver references can predate the exported signature records.
-- Retain that eligibility separately from the original signature evidence.
ALTER TABLE members ADD COLUMN legacy_waiver_signed INTEGER NOT NULL DEFAULT 0
  CHECK (legacy_waiver_signed IN (0, 1));

CREATE TRIGGER edge_legacy_waiver_change AFTER UPDATE OF legacy_waiver_signed ON members
WHEN OLD.legacy_waiver_signed IS NOT NEW.legacy_waiver_signed
BEGIN UPDATE edge_changes SET revision = revision + 1; END;
