CREATE TABLE members (
  member_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  discord_user_id TEXT NOT NULL UNIQUE,
  discord_username TEXT NOT NULL,
  discord_email TEXT NOT NULL,
  billing_name TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  name_override TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  metadata_version INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  bill_annually INTEGER NOT NULL DEFAULT 0 CHECK (bill_annually IN (0, 1)),
  discount_type TEXT NOT NULL DEFAULT '' CHECK (discount_type IN ('', 'military', 'retired', 'firstResponder', 'student', 'family')),
  discount_status TEXT NOT NULL DEFAULT '' CHECK (discount_status IN ('', 'requested', 'approved', 'denied')),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  stripe_subscription_state TEXT,
  stripe_synced_at INTEGER,
  discord_last_synced INTEGER
) STRICT;
CREATE INDEX members_created ON members(created DESC, discord_user_id DESC);
