CREATE TABLE members (
  discord_user_id TEXT PRIMARY KEY,
  discord_username TEXT NOT NULL,
  discord_email TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  custom_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_metadata) AND json_type(custom_metadata) = 'object'),
  metadata_version INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  bill_annually INTEGER NOT NULL,
  discount_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup', 'admin')),
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX oauth_expiry ON oauth_states(expires);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES members(discord_user_id),
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX session_expiry ON sessions(expires);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_session_expiry ON admin_sessions(expires);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  processed INTEGER NOT NULL
) STRICT;
