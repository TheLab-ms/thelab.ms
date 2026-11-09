-- Pre-paid wallet. The balance is the sum of entries in cents; it is never
-- stored, so a redemption and a top-up can't disagree. Every insert carries a
-- unique key so retried checkouts and redemptions credit or charge once.
CREATE TABLE wallet_entries (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  amount INTEGER NOT NULL CHECK (amount != 0),
  item TEXT NOT NULL DEFAULT '' CHECK (length(item) <= 80),
  key TEXT NOT NULL CHECK (length(key) > 0),
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE UNIQUE INDEX wallet_entries_key ON wallet_entries(member_id, key);
CREATE INDEX wallet_entries_member ON wallet_entries(member_id, entry_id DESC);

-- Wallet activity is visible in the existing member history and events pages.
CREATE TRIGGER wallet_entry_event AFTER INSERT ON wallet_entries
WHEN NEW.member_id IS NOT NULL
BEGIN
  INSERT INTO member_events (member_id, event_type, details)
  VALUES (NEW.member_id, CASE WHEN NEW.amount > 0 THEN 'WalletTopUp' ELSE 'WalletCharge' END,
    json_object('entry_id', NEW.entry_id, 'amount', NEW.amount, 'item', NEW.item,
      'note', json_extract(NEW.details, '$.note')));
END;
