// Shared by edge goal selection and the admin's saved fob status. The outer
// query must use the members table so linked waivers resolve to that member.
export const waiverSignedSQL = `(members.legacy_waiver_signed = 1
  OR EXISTS (SELECT 1 FROM waivers WHERE waivers.member_id = members.member_id))`;

export const memberAccessSQL = `(members.non_billable = 1
  OR ((members.legacy_billing = 1 OR members.stripe_subscription_state IN ('active', 'trialing'))
    AND ${waiverSignedSQL}))`;

export const fobEnabledSQL = `members.fob_id IS NOT NULL AND ${memberAccessSQL}`;
