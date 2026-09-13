import { discounts, HttpError } from './http.js';

export function validateMetadata(input) {
  const invalid = message => { throw new HttpError(400, message); };
  const text = (key, max, required = false) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(`Invalid ${key.replaceAll('_', ' ')} (maximum ${max} characters).`);
    return value.trim();
  };
  const email = (key, required) => {
    const value = text(key, 254, required);
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid('Enter a valid email address.');
    return value.toLowerCase();
  };
  if (!input || typeof input !== 'object') invalid('Invalid member metadata.');
  const value = {
    discord_username: text('discord_username', 80, true),
    discord_email: email('discord_email', true),
    contact_name: text('contact_name', 160),
    contact_email: email('contact_email', false),
    notes: text('notes', 5000),
  };
  if (!['monthly', 'yearly'].includes(input.billing)) invalid('Choose monthly or yearly billing.');
  if (!discounts.includes(input.discount_type) || !['', 'requested', 'approved', 'denied'].includes(input.discount_status)
    || Boolean(input.discount_type) !== Boolean(input.discount_status)) invalid('Standard rate requires no discount status; a discount category requires requested, approved, or denied status.');
  if (!/^(0|[1-9]\d{0,14})$/.test(input.metadata_version || '')) invalid('Invalid member version. Reload the member before saving.');
  const raw = text('custom_metadata', 16000, true);
  let custom;
  try { custom = JSON.parse(raw); } catch { invalid('Custom metadata must be a JSON object with text keys and values.'); }
  if (!custom || Array.isArray(custom) || typeof custom !== 'object' || Object.keys(custom).length > 50
    || Object.entries(custom).some(([key, item]) => !key.trim() || key.length > 80 || typeof item !== 'string' || item.length > 1000)) {
    invalid('Custom metadata supports up to 50 text key/value pairs (keys: 80 characters, values: 1,000 characters).');
  }
  return { ...value, bill_annually: input.billing === 'yearly' ? 1 : 0, discount_type: input.discount_type,
    discount_status: input.discount_status, custom_metadata: JSON.stringify(custom), metadata_version: Number(input.metadata_version) };
}
