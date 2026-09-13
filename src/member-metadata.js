import { discordID, discounts, HttpError } from './http.js';

export const memberName = member => member.name_override?.trim() || member.billing_name?.trim() || member.discord_username;

export function validateMetadata(input) {
  const invalid = message => { throw new HttpError(400, message); };
  const text = (key, max, required = false) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(`Invalid ${key.replaceAll('_', ' ')} (maximum ${max} characters).`);
    return value.trim();
  };
  if (!input || typeof input !== 'object') invalid('Invalid member metadata.');
  const value = {
    discord_user_id: text('discord_user_id', 20, true),
    stripe_customer_id: text('stripe_customer_id', 255) || null,
    stripe_subscription_id: text('stripe_subscription_id', 255) || null,
    name_override: text('name_override', 160),
    notes: text('notes', 5000),
  };
  if (!discordID.test(value.discord_user_id)) invalid('Enter a valid Discord ID.');
  if (value.stripe_customer_id && !/^cus_[A-Za-z0-9]+$/.test(value.stripe_customer_id)) invalid('Enter a valid Stripe customer ID.');
  if (value.stripe_subscription_id && (!value.stripe_customer_id || !/^sub_[A-Za-z0-9]+$/.test(value.stripe_subscription_id))) invalid('A valid Stripe subscription ID requires a Stripe customer ID.');
  if (!['monthly', 'yearly'].includes(input.billing)) invalid('Choose monthly or yearly billing.');
  if (!discounts.includes(input.discount_type) || !['', 'requested', 'approved', 'denied'].includes(input.discount_status)
    || Boolean(input.discount_type) !== Boolean(input.discount_status)) invalid('Standard rate requires no discount status; a discount category requires requested, approved, or denied status.');
  if (!/^(0|[1-9]\d{0,14})$/.test(input.metadata_version || '')) invalid('Invalid member version. Reload the member before saving.');
  return { ...value, bill_annually: input.billing === 'yearly' ? 1 : 0, discount_type: input.discount_type,
    discount_status: input.discount_status, metadata_version: Number(input.metadata_version) };
}
