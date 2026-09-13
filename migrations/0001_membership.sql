CREATE TABLE members (
  member_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  discord_user_id TEXT UNIQUE,
  discord_username TEXT NOT NULL DEFAULT '',
  discord_email TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE CHECK (email IS NULL OR (email = lower(trim(email)) AND length(email) > 0)),
  waiver_name TEXT NOT NULL DEFAULT '',
  billing_name TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  name_override TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  fob_id INTEGER UNIQUE CHECK (fob_id BETWEEN 1 AND 4294967295),
  metadata_version INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  bill_annually INTEGER NOT NULL DEFAULT 0 CHECK (bill_annually IN (0, 1)),
  discount_type TEXT NOT NULL DEFAULT '' CHECK (discount_type IN ('', 'military', 'retired', 'firstResponder', 'student', 'family')),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  stripe_subscription_state TEXT,
  stripe_synced_at INTEGER,
  discord_last_synced INTEGER
) STRICT;
CREATE INDEX members_created ON members(created DESC, discord_user_id DESC);

-- Transactional access-change marker; the coordinator acknowledges revisions
-- only after edge persistence. Assignment intervals retain historical ownership.
CREATE TABLE edge_changes (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL) STRICT;
INSERT INTO edge_changes VALUES (1, 1);
CREATE TABLE fob_assignments (
  id INTEGER PRIMARY KEY,
  fob INTEGER NOT NULL,
  member_id TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  started REAL NOT NULL DEFAULT (unixepoch('subsec')),
  ended REAL
) STRICT;
CREATE INDEX fob_assignment_lookup ON fob_assignments(fob, started, ended);
CREATE TRIGGER member_fob_changed AFTER UPDATE OF fob_id ON members WHEN OLD.fob_id IS NOT NEW.fob_id
BEGIN
  UPDATE fob_assignments SET ended = unixepoch('subsec') WHERE member_id = NEW.member_id AND ended IS NULL;
  INSERT INTO fob_assignments(fob, member_id) SELECT NEW.fob_id, NEW.member_id WHERE NEW.fob_id IS NOT NULL;
  INSERT INTO member_events(member_id, event_type, details) VALUES (NEW.member_id, 'FobChanged', json_object('from', OLD.fob_id, 'to', NEW.fob_id));
END;
CREATE TRIGGER edge_member_insert AFTER INSERT ON members BEGIN
  UPDATE edge_changes SET revision = revision + 1;
  INSERT INTO fob_assignments(fob, member_id) SELECT NEW.fob_id, NEW.member_id WHERE NEW.fob_id IS NOT NULL;
END;
CREATE TRIGGER edge_member_change AFTER UPDATE OF fob_id, stripe_subscription_state ON members
WHEN OLD.fob_id IS NOT NEW.fob_id OR OLD.stripe_subscription_state IS NOT NEW.stripe_subscription_state
BEGIN UPDATE edge_changes SET revision = revision + 1; END;
CREATE TRIGGER edge_member_delete BEFORE DELETE ON members BEGIN
  UPDATE edge_changes SET revision = revision + 1;
  UPDATE fob_assignments SET ended = unixepoch('subsec') WHERE member_id = OLD.member_id AND ended IS NULL;
END;

CREATE TABLE waivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  agreements TEXT NOT NULL CHECK (json_valid(agreements))
) STRICT;
CREATE INDEX waivers_member ON waivers(member_id, id DESC);
CREATE TRIGGER edge_waiver_insert AFTER INSERT ON waivers BEGIN UPDATE edge_changes SET revision = revision + 1; END;
CREATE TRIGGER edge_waiver_link AFTER UPDATE OF member_id ON waivers BEGIN UPDATE edge_changes SET revision = revision + 1; END;
-- Signature evidence, including the exact source text, is append-only.
CREATE TRIGGER waiver_evidence_immutable BEFORE UPDATE OF version, content, created, name, email, agreements ON waivers BEGIN SELECT RAISE(ABORT, 'Waiver evidence is immutable'); END;
CREATE TRIGGER waiver_retained BEFORE DELETE ON waivers BEGIN SELECT RAISE(ABORT, 'Waiver evidence is retained'); END;

-- History is written in the same transaction as the member change, including
-- changes made by sign-in and Stripe reconciliation. Retain it indefinitely.
CREATE TABLE member_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  member_id TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE INDEX member_events_created ON member_events(created DESC, id DESC);
CREATE INDEX member_events_member_created ON member_events(member_id, created DESC, id DESC);
CREATE INDEX member_events_type_created ON member_events(event_type, created DESC, id DESC);

CREATE TABLE edge_swipes (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  controller TEXT NOT NULL,
  fob INTEGER NOT NULL CHECK (fob BETWEEN 1 AND 4294967295),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  member_id TEXT REFERENCES members(member_id) ON DELETE SET NULL
) STRICT;
CREATE TRIGGER edge_swipe_history AFTER INSERT ON edge_swipes BEGIN
  INSERT INTO member_events(created, member_id, event_type, details)
  VALUES (CAST(unixepoch(NEW.time) AS INTEGER), NEW.member_id, 'FobSwipe',
    json_object('id', NEW.id, 'time', NEW.time, 'controller', NEW.controller, 'fob', NEW.fob, 'allowed', NEW.allowed));
END;

CREATE TRIGGER member_registered AFTER INSERT ON members
BEGIN
  INSERT INTO member_events (member_id, event_type) VALUES (NEW.member_id, 'MemberRegistered');
END;

CREATE TRIGGER waiver_signed AFTER INSERT ON waivers
BEGIN
  UPDATE members SET waiver_name = CASE WHEN waiver_name = '' THEN NEW.name ELSE waiver_name END,
    metadata_version = metadata_version + 1 WHERE member_id = NEW.member_id;
  INSERT INTO member_events (member_id, event_type, details)
    VALUES (NEW.member_id, 'WaiverSigned', json_object('waiver_id', NEW.id, 'version', NEW.version));
END;

-- IS NOT compares NULLs safely. Version/sync timestamp updates and repeated
-- provider deliveries produce no events unless a tracked value really changes.
CREATE TRIGGER member_changed AFTER UPDATE OF
  discord_user_id, discord_username, discord_email, billing_name, billing_email,
  name_override, notes, bill_annually, discount_type, stripe_customer_id,
  stripe_subscription_id, stripe_subscription_state ON members
BEGIN
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'DiscordAccountChanged', json_object('from', OLD.discord_user_id, 'to', NEW.discord_user_id)
    WHERE OLD.discord_user_id IS NOT NEW.discord_user_id;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'DiscordUsernameChanged', json_object('from', OLD.discord_username, 'to', NEW.discord_username)
    WHERE OLD.discord_username IS NOT NEW.discord_username;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'DiscordEmailChanged', json_object('from', OLD.discord_email, 'to', NEW.discord_email)
    WHERE OLD.discord_email IS NOT NEW.discord_email;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'BillingNameChanged', json_object('from', OLD.billing_name, 'to', NEW.billing_name)
    WHERE OLD.billing_name IS NOT NEW.billing_name;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'BillingEmailChanged', json_object('from', OLD.billing_email, 'to', NEW.billing_email)
    WHERE OLD.billing_email IS NOT NEW.billing_email;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'NameOverrideChanged', json_object('from', OLD.name_override, 'to', NEW.name_override)
    WHERE OLD.name_override IS NOT NEW.name_override;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'NotesUpdated', '{}'
    WHERE OLD.notes IS NOT NEW.notes;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'BillingCycleChanged', json_object('from', OLD.bill_annually, 'to', NEW.bill_annually)
    WHERE OLD.bill_annually IS NOT NEW.bill_annually;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'DiscountTypeModified', json_object('from', OLD.discount_type, 'to', NEW.discount_type)
    WHERE OLD.discount_type IS NOT NEW.discount_type;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'StripeCustomerChanged', json_object('from', OLD.stripe_customer_id, 'to', NEW.stripe_customer_id)
    WHERE OLD.stripe_customer_id IS NOT NEW.stripe_customer_id;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'StripeSubscriptionChanged', json_object('from', OLD.stripe_subscription_id, 'to', NEW.stripe_subscription_id)
    WHERE OLD.stripe_subscription_id IS NOT NEW.stripe_subscription_id;
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'SubscriptionStatusChanged', json_object('from', OLD.stripe_subscription_state, 'to', NEW.stripe_subscription_state)
    WHERE OLD.stripe_subscription_state IS NOT NEW.stripe_subscription_state;
END;
