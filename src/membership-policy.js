export const discounts = ['', 'military', 'retired', 'firstResponder', 'student', 'family'];

export const grantsMembership = status => ['active', 'trialing'].includes(status);
export const isOngoingSubscription = status => !['canceled', 'incomplete_expired'].includes(status);

export function selectCurrentSubscription(subscriptions) {
  const priority = sub => grantsMembership(sub.status) ? 2 : isOngoingSubscription(sub.status) ? 1 : 0;
  return subscriptions.toSorted((a, b) => priority(b) - priority(a) || b.created - a.created)[0];
}
