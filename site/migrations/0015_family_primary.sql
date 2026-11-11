-- A Family discount is qualified by another member's membership. Leadership
-- links the primary; deleting the primary leaves the discount unlinked.
ALTER TABLE members ADD COLUMN family_primary_id TEXT REFERENCES members(member_id) ON DELETE SET NULL
  CHECK (family_primary_id IS NULL OR (family_primary_id <> member_id AND discount_type = 'family'));
CREATE INDEX members_family_primary ON members(family_primary_id);

-- Names are captured when the link changes, so history still reads after a primary is renamed or deleted.
CREATE TRIGGER family_primary_linked AFTER INSERT ON members WHEN NEW.family_primary_id IS NOT NULL
BEGIN
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'FamilyPrimaryChanged', json_object('from', NULL, 'from_name', NULL,
    'to', NEW.family_primary_id, 'to_name', (SELECT COALESCE(NULLIF(trim(name_override), ''), NULLIF(trim(billing_name), ''),
      NULLIF(discord_username, ''), NULLIF(waiver_name, ''), email) FROM members WHERE member_id = NEW.family_primary_id));
END;
CREATE TRIGGER family_primary_changed AFTER UPDATE OF family_primary_id ON members
WHEN OLD.family_primary_id IS NOT NEW.family_primary_id
BEGIN
  INSERT INTO member_events (member_id, event_type, details)
  SELECT NEW.member_id, 'FamilyPrimaryChanged', json_object(
    'from', OLD.family_primary_id, 'from_name', (SELECT COALESCE(NULLIF(trim(name_override), ''), NULLIF(trim(billing_name), ''),
      NULLIF(discord_username, ''), NULLIF(waiver_name, ''), email) FROM members WHERE member_id = OLD.family_primary_id),
    'to', NEW.family_primary_id, 'to_name', (SELECT COALESCE(NULLIF(trim(name_override), ''), NULLIF(trim(billing_name), ''),
      NULLIF(discord_username, ''), NULLIF(waiver_name, ''), email) FROM members WHERE member_id = NEW.family_primary_id));
END;

-- Conway exported each member's metadata as JSON at the end of their notes,
-- with root_family_member naming the primary's Conway id. Link members who
-- still have the Family discount; the notes are left as imported.
WITH conway AS (
  SELECT member_id, discount_type, substr(notes, instr(notes, 'Conway source metadata: {') + 24) AS blob
  FROM members WHERE instr(notes, 'Conway source metadata: {') > 0
), parsed AS (
  SELECT member_id, discount_type,
    CASE WHEN json_valid(blob) THEN json_extract(blob, '$.id') END AS conway_id,
    CASE WHEN json_valid(blob) THEN json_extract(blob, '$.root_family_member') END AS root
  FROM conway
)
UPDATE members SET family_primary_id = p.member_id
FROM parsed AS child JOIN parsed AS p ON p.conway_id = child.root
WHERE members.member_id = child.member_id AND child.discount_type = 'family'
  AND p.discount_type <> 'family' AND p.member_id <> child.member_id;
