-- Conway's imported metadata blob is reduced to what leadership still uses:
-- PayPal billing references, Lifetime membership, and Conway discounts.
-- Text written before the blob is kept, and no other member column changes.
WITH conway AS (
  SELECT member_id,
    rtrim(substr(notes, 1, instr(notes, 'Conway source metadata: {') - 1), char(9, 10, 13, 32)) AS kept,
    substr(notes, instr(notes, 'Conway source metadata: {') + 24) AS blob
  FROM members WHERE instr(notes, 'Conway source metadata: {') > 0
), parsed AS (
  SELECT member_id, kept,
    CASE WHEN json_valid(blob) THEN COALESCE(json_extract(blob, '$.discount_type'), '') END AS discount,
    CASE WHEN json_valid(blob) THEN COALESCE(json_extract(blob, '$.discount_status'), '') END AS status,
    CASE WHEN json_valid(blob) THEN json_extract(blob, '$.paypal_subscription_id') END AS paypal_subscription,
    CASE WHEN json_valid(blob) THEN json_extract(blob, '$.paypal_price') END AS paypal_price
  FROM conway WHERE json_valid(blob)
), facts AS (
  SELECT member_id, kept, substr(
    CASE WHEN discount = 'Lifetime' THEN '; Lifetime member' ELSE '' END ||
    CASE WHEN discount NOT IN ('', 'none', 'Lifetime')
      THEN '; ' || discount || ' discount' || CASE WHEN status <> '' THEN ' (' || status || ')' ELSE '' END
      ELSE '' END ||
    CASE WHEN paypal_subscription IS NOT NULL THEN '; PayPal subscription ' || paypal_subscription ELSE '' END ||
    CASE WHEN paypal_price IS NOT NULL THEN '; PayPal price ' || paypal_price ELSE '' END, 3) AS text
  FROM parsed
)
UPDATE members SET notes = facts.kept || CASE
    WHEN facts.text = '' THEN ''
    WHEN facts.kept = '' THEN 'From Conway: ' || facts.text
    ELSE char(10, 10) || 'From Conway: ' || facts.text END
FROM facts WHERE members.member_id = facts.member_id;
