-- Resolve a swipe's owner from the newest matching assignment without sorting
-- or table lookups. id is listed explicitly so the index matches the tie-breaker.
DROP INDEX fob_assignment_lookup;
CREATE INDEX fob_assignment_lookup ON fob_assignments(fob, started, id, ended, member_id);

-- Keep waiver status on the member row so access checks, filters and counts
-- need no per-member waiver lookups. Set from Conway's legacy flag or any
-- linked signature. Stored rather than generated so indexes on it can cover.
ALTER TABLE members ADD COLUMN waiver_signed INTEGER NOT NULL DEFAULT 0 CHECK (waiver_signed IN (0, 1));
UPDATE members SET waiver_signed = 1
WHERE legacy_waiver_signed = 1 OR member_id IN (SELECT member_id FROM waivers);

DROP TRIGGER waiver_signed;
CREATE TRIGGER waiver_signed AFTER INSERT ON waivers
BEGIN
  UPDATE members SET waiver_name = CASE WHEN waiver_name = '' THEN NEW.name ELSE waiver_name END,
    waiver_signed = 1, metadata_version = metadata_version + 1 WHERE member_id = NEW.member_id;
  INSERT INTO member_events (member_id, event_type, details)
    VALUES (NEW.member_id, 'WaiverSigned', json_object('waiver_id', NEW.id, 'version', NEW.version));
END;

CREATE TRIGGER waiver_relinked AFTER UPDATE OF member_id ON waivers
WHEN OLD.member_id IS NOT NEW.member_id
BEGIN
  UPDATE members SET waiver_signed = (legacy_waiver_signed = 1
    OR EXISTS (SELECT 1 FROM waivers WHERE waivers.member_id = members.member_id))
  WHERE member_id IN (OLD.member_id, NEW.member_id);
END;

CREATE TRIGGER legacy_waiver_inserted AFTER INSERT ON members WHEN NEW.legacy_waiver_signed = 1
BEGIN UPDATE members SET waiver_signed = 1 WHERE member_id = NEW.member_id; END;

CREATE TRIGGER legacy_waiver_changed AFTER UPDATE OF legacy_waiver_signed ON members
WHEN OLD.legacy_waiver_signed IS NOT NEW.legacy_waiver_signed
BEGIN
  UPDATE members SET waiver_signed = (legacy_waiver_signed = 1
    OR EXISTS (SELECT 1 FROM waivers WHERE waivers.member_id = members.member_id))
  WHERE member_id = NEW.member_id;
END;

-- The default admin member list: Discord-linked members by waiver status, newest first.
CREATE INDEX members_linked_waiver ON members(waiver_signed, created DESC, discord_user_id DESC, member_id DESC)
  WHERE discord_user_id IS NOT NULL;
