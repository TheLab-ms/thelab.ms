CREATE TABLE fob_claims (
  id TEXT PRIMARY KEY,
  fob_id INTEGER NOT NULL CHECK (fob_id BETWEEN 1 AND 4294967295),
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  claimed_by TEXT
) STRICT;
CREATE INDEX fob_claims_expires ON fob_claims(expires);

-- Consumption and assignment are one statement/transaction. A unique-fob
-- conflict rolls back consumption as well as the member/history changes.
CREATE TRIGGER fob_claim_redeemed AFTER UPDATE OF claimed_by ON fob_claims
WHEN OLD.claimed_by IS NULL AND NEW.claimed_by IS NOT NULL
BEGIN
  UPDATE members SET fob_id = NEW.fob_id, metadata_version = metadata_version + 1
    WHERE member_id = NEW.claimed_by;
END;
