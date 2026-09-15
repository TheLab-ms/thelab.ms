-- Allow indexed lookups on both sides of email = ? OR discord_email = ?.
CREATE INDEX members_discord_email ON members(discord_email);

-- Find open assignments when changing a member's fob or deleting a member.
CREATE INDEX fob_assignments_member_ended ON fob_assignments(member_id, ended);

-- Filter a member's history by event type while preserving newest-first order.
CREATE INDEX member_events_member_type_created ON member_events(member_id, event_type, created DESC, id DESC);

-- Match the complete admin member-list ordering, including its tie-breaker.
DROP INDEX members_created;
CREATE INDEX members_created ON members(created DESC, discord_user_id DESC, member_id DESC);
