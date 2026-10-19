-- Only the latest started Stripe lookup may publish its result. This counter
-- is separate from admin edit versions so routine webhooks do not stale forms.
ALTER TABLE members ADD COLUMN stripe_sync_version INTEGER NOT NULL DEFAULT 0;
