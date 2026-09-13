// Shared by edge goal selection and the admin's saved fob status. The outer
// query must use the members table so linked waivers resolve to that member.
export const fobEnabledSQL = `members.fob_id IS NOT NULL AND (members.non_billable = 1
  OR ((members.legacy_billing = 1 OR members.stripe_subscription_state = 'active')
    AND EXISTS (SELECT 1 FROM waivers WHERE waivers.member_id = members.member_id)))`;
