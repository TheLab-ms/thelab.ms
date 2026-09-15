ALTER TABLE members ADD COLUMN github_user_id TEXT;
ALTER TABLE members ADD COLUMN github_username TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX members_github_user_id ON members(github_user_id);

CREATE TRIGGER member_github_changed AFTER UPDATE OF github_user_id ON members
WHEN OLD.github_user_id IS NOT NEW.github_user_id
BEGIN
  INSERT INTO member_events(member_id, event_type, details)
  VALUES (NEW.member_id, 'GitHubAccountChanged', json_object('from', OLD.github_user_id, 'to', NEW.github_user_id));
END;
