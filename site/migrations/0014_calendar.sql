-- Schedules are versioned by occurrence number. Moving an occurrence or changing
-- a series never changes the identity used by its links and RSVPs.
CREATE TABLE calendar_events (
  event_id TEXT PRIMARY KEY,
  organizer_id TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  revision TEXT NOT NULL,
  cancel_from INTEGER CHECK (cancel_from >= 0),
  created INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE calendar_schedules (
  event_id TEXT NOT NULL REFERENCES calendar_events(event_id) ON DELETE CASCADE,
  first_occurrence INTEGER NOT NULL CHECK (first_occurrence >= 0),
  schedule TEXT NOT NULL CHECK (json_valid(schedule)),
  PRIMARY KEY (event_id, first_occurrence)
) STRICT;
CREATE TABLE calendar_overrides (
  event_id TEXT NOT NULL REFERENCES calendar_events(event_id) ON DELETE CASCADE,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
  schedule TEXT NOT NULL CHECK (json_valid(schedule)),
  PRIMARY KEY (event_id, occurrence)
) STRICT;
CREATE TABLE calendar_rsvps (
  event_id TEXT NOT NULL REFERENCES calendar_events(event_id) ON DELETE CASCADE,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
  member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
  created INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, occurrence, member_id)
) STRICT;
CREATE INDEX calendar_events_organizer ON calendar_events(organizer_id);
CREATE INDEX calendar_rsvps_member ON calendar_rsvps(member_id);
