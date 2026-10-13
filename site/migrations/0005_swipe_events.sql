-- Keep history row IDs, timestamps, ownership and details intact. Only FobSwipe
-- details.id is a swipe identity: ConwayEvent details.id is an unrelated CSV ID.
-- The Conway importer used 'conway:' || uid; retain that namespace verbatim.
ALTER TABLE member_events ADD COLUMN source_event_id TEXT;
UPDATE member_events SET source_event_id = json_extract(details, '$.id')
WHERE event_type = 'FobSwipe' AND json_type(details, '$.id') = 'text'
  AND length(json_extract(details, '$.id')) > 0;

-- Fail on ambiguous duplicate identities before removing any source data.
-- NULL remains valid for ordinary history and swipes without a source ID.
CREATE UNIQUE INDEX member_events_source_event_id ON member_events(source_event_id);

-- Normally every edge row already has trigger-written history. Recover any
-- missing history from the stored owner, never from today's fob assignment.
INSERT INTO member_events(created, member_id, event_type, details, source_event_id)
SELECT CAST(unixepoch(s.time) AS INTEGER), s.member_id, 'FobSwipe',
  json_object('id', s.id, 'time', s.time, 'controller', s.controller, 'fob', s.fob, 'allowed', s.allowed), s.id
FROM edge_swipes AS s
WHERE NOT EXISTS (SELECT 1 FROM member_events AS e WHERE e.source_event_id = s.id);

DROP TRIGGER edge_swipe_history;
DROP TABLE edge_swipes;
