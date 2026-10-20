-- Kiosk claims are signed tokens verified without database state.
-- Dropping the table also drops its index and fob_claim_redeemed trigger.
DROP TABLE fob_claims;
