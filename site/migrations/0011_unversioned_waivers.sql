-- A waiver is either signed or not; the waiver text is no longer versioned.
-- Triggers that reference the column must be dropped before it can be.
DROP TRIGGER waiver_evidence_immutable;
DROP TRIGGER waiver_signed;
ALTER TABLE waivers DROP COLUMN version;

CREATE TRIGGER waiver_evidence_immutable BEFORE UPDATE OF content, created, name, email, agreements ON waivers
BEGIN SELECT RAISE(ABORT, 'Waiver evidence is immutable'); END;

CREATE TRIGGER waiver_signed AFTER INSERT ON waivers
BEGIN
  UPDATE members SET waiver_name = CASE WHEN waiver_name = '' THEN NEW.name ELSE waiver_name END,
    waiver_signed = 1, metadata_version = metadata_version + 1 WHERE member_id = NEW.member_id;
  INSERT INTO member_events (member_id, event_type, details)
    VALUES (NEW.member_id, 'WaiverSigned', json_object('waiver_id', NEW.id));
END;

UPDATE member_events SET details = json_remove(details, '$.version') WHERE event_type = 'WaiverSigned';
