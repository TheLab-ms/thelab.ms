import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addWaiver, call, insertMember, mockFetch, post, quiet, readMember, resetDB, session, stripeEvent } from './helpers.js';

const adminID = '444444444444444444';
const discordAPI = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members`;
const guildMember = id => [`GET`, `${discordAPI}/${id}`, { user: { id, username: `user-${id.slice(0, 3)}` } }];
const role = (method, id, status = 204) => [method, `${discordAPI}/${id}/roles/${env.DISCORD_ROLE_ID}`, new Response(null, { status })];

describe('Admin', () => {
  let cookie;
  const get = path => call(path, { headers: { Cookie: cookie } });
  const save = (member, fields = {}) => call(`/admin/members/${member.member_id}`, post({
    metadata_version: String(member.metadata_version), name_override: '', notes: '', fob_id: member.fob_id ?? '',
    discord_user_id: member.discord_user_id ?? '', stripe_customer_id: member.stripe_customer_id ?? '',
    billing: 'monthly', discount_type: '', ...fields,
  }, { Cookie: cookie }));

  beforeEach(async () => {
    await resetDB();
    cookie = await session(adminID, true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('requires an admin session', async () => {
    quiet();
    mockFetch();
    let response = await call('/admin/events?page=2');
    expect(response.headers.get('Location')).toBe('/login?next=%2Fadmin%2Fevents%3Fpage%3D2');
    response = await call('/admin', { headers: { Cookie: await session(adminID) } });
    expect(response.status).toBe(403);
    response = await call('/admin/members/new', post({ email: 'a@example.com' }));
    expect(response.status).toBe(401);
    response = await call('/admin/members/new', post({ email: 'a@example.com' }, { Cookie: cookie, Origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first()).n).toBe(0);
  });

  it('lists members with filters and searches all members', async () => {
    const signed = await insertMember({ discord_user_id: '333333333333333333', discord_username: 'signed-maker', non_billable: 1 });
    await addWaiver(signed.member_id);
    await insertMember({ email: 'pending@example.com', name_override: 'Pending <Maker>' });
    let html = await (await get('/admin/')).text();
    expect(html).toContain('signed-maker');
    expect(html).toContain('<small>Non-billable</small>');
    expect(html).not.toContain('Pending');
    html = await (await get('/admin?waiver=all&discord=all')).text();
    expect(html).toContain('Pending &lt;Maker&gt;');
    html = await (await get('/admin?q=pending')).text();
    expect(html).toContain('1 matching member</strong>');
    expect(html).toContain('Pending &lt;Maker&gt;');
    expect(html).toMatch(/<select id="waiver" name="waiver" disabled/);
    expect(html).toContain('<a href="/admin">Clear</a>');
    expect(await (await get('/admin')).text()).not.toContain('>Clear</a>');
    expect((await get('/admin?page=9')).headers.get('Location')).toBe('/admin?page=1');
    expect((await get('/admin?page=bogus&waiver=bogus')).status).toBe(200);
  });

  it('renders empty member and event tables', async () => {
    expect(await (await get('/admin')).text()).toContain('<td colspan="2" class="admin-empty">No members match your search and filters.</td>');
    const html = await (await get('/admin?waiver=all&discord=all')).text();
    expect(html).toContain('0 registered members</strong>');
    expect(html).toContain('<td colspan="2" class="admin-empty">No members have registered yet.</td>');
    expect(await (await get('/admin/events')).text()).toContain('<td colspan="4">No member history found.</td>');
  });

  it('escapes editor content and preserves selected, checked, and empty field values', async () => {
    const member = await insertMember({
      name_override: 'Maker "<&>', notes: '</textarea><script>alert(1)</script>',
      non_billable: 1, bill_annually: 1, discount_type: 'student',
    });
    const html = await (await get(`/admin/members/${member.member_id}`)).text();
    expect(html).toContain('<title>Edit Maker &quot;&lt;&amp;&gt; | TheLab</title>');
    expect(html).toContain('name="name_override" type="text" value="Maker &quot;&lt;&amp;&gt;"');
    expect(html).toContain('data-confirm="Delete Maker &quot;&lt;&amp;&gt;? This cannot be undone.');
    expect(html).toContain('rows="4">&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;</textarea>');
    expect(html).toContain('name="non_billable" type="checkbox" checked>');
    expect(html).toContain('name="legacy_billing" type="checkbox">');
    expect(html).toContain('<option value="yearly" selected>Yearly</option>');
    expect(html).toContain('<option value="student" selected>Student</option>');
    expect(html).toContain('name="fob_id" type="text" value=""');
  });

  it('creates members, verifying Discord accounts and rejecting duplicates with the draft kept', async () => {
    quiet();
    mockFetch([guildMember('333333333333333333')]);
    const response = await call('/admin/members/new', post({
      email: ' New@Example.com ', name_override: 'New Maker', discord_user_id: '333333333333333333', billing: 'yearly', discount_type: 'student', notes: '',
    }, { Cookie: cookie }));
    expect(response.status).toBe(303);
    const member = await env.DB.prepare('SELECT * FROM members').first();
    expect(response.headers.get('Location')).toBe(`/admin/members/${member.member_id}?notice=created`);
    expect(member).toMatchObject({ email: 'new@example.com', discord_username: 'user-333', bill_annually: 1, discount_type: 'student' });
    const duplicate = await call('/admin/members/new', post({ email: 'new@example.com', name_override: 'Draft name', billing: 'monthly', discount_type: '' }, { Cookie: cookie }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain('value="Draft name"');
  });

  it('saves settings, records history, and pushes access changes', async () => {
    mockFetch();
    const member = await insertMember({ email: 'maker@example.com' });
    const response = await save(member, { name_override: 'Renamed', fob_id: '7', non_billable: 'on', notes: 'Hello' });
    expect(response.headers.get('Location')).toBe(`/admin/members/${member.member_id}?notice=saved`);
    expect(await readMember(member.member_id)).toMatchObject({ name_override: 'Renamed', fob_id: 7, non_billable: 1, notes: 'Hello', metadata_version: 1 });
    const html = await (await get(`/admin/members/${member.member_id}?notice=saved`)).text();
    expect(html).toContain('Member saved.');
    expect(html).toContain('>Fob enabled</span>');
    expect(html).toContain('Disabled → Enabled');
    expect(html).toContain('<script src="/admin.js" defer>');
    // Pressing Enter submits the first submit button, which must be Save, not Generate checkout link.
    const editorForm = html.slice(html.indexOf('class="admin-form admin-editor"'));
    expect(editorForm.match(/<button[^>]*type="submit"[^>]*>([^<]*)/)[1]).toBe('Save changes');
    const events = (await env.DB.prepare('SELECT event_type FROM member_events ORDER BY event_type').all()).results.map(e => e.event_type);
    expect(events).toEqual(['FobChanged', 'MemberRegistered', 'NameOverrideChanged', 'NonBillableChanged', 'NotesUpdated']);
  });

  it('rejects stale and conflicting edits while keeping the draft', async () => {
    quiet();
    mockFetch();
    await insertMember({ fob_id: 7 });
    const member = await insertMember({});
    for (const [fields, status, message] of [
      [{ metadata_version: '5', notes: 'Keep <me>' }, 409, 'changed after you opened the form'],
      [{ fob_id: '7', notes: 'Keep <me>' }, 409, 'That fob already belongs to another member.'],
      [{ fob_id: '0', notes: 'Keep <me>' }, 400, 'Enter a fob ID'],
      [{ stripe_customer_id: 'bogus', notes: 'Keep <me>' }, 400, 'valid Stripe customer ID'],
    ]) {
      const response = await save(member, fields);
      expect(response.status).toBe(status);
      const html = await response.text();
      expect(html).toContain(message);
      expect(html).toContain('Keep &lt;me&gt;');
    }
    expect(await readMember(member.member_id)).toMatchObject({ metadata_version: 0, notes: '' });
  });

  it('transfers Discord roles and syncs a changed Stripe customer', async () => {
    const member = await insertMember({ discord_user_id: '333333333333333333', stripe_customer_id: 'cus_old', stripe_subscription_id: 'sub_old', stripe_subscription_state: 'active' });
    const calls = mockFetch([
      guildMember('555555555555555555'),
      ['GET', 'https://api.stripe.com/v1/customers/cus_new', { id: 'cus_new', name: 'New Billing' }],
      ['GET', /\/v1\/subscriptions\?customer=cus_new/, { data: [{ id: 'sub_new', status: 'active', created: 1 }], has_more: false }],
      role('DELETE', '333333333333333333'), role('PUT', '555555555555555555'),
    ]);
    expect((await save(member, { discord_user_id: '555555555555555555', stripe_customer_id: 'cus_new' })).headers.get('Location')).toContain('notice=saved');
    expect(await readMember(member.member_id)).toMatchObject({
      discord_user_id: '555555555555555555', discord_username: 'user-555', stripe_customer_id: 'cus_new',
      stripe_subscription_id: 'sub_new', stripe_subscription_state: 'active', billing_name: 'New Billing',
    });
    expect(calls.filter(c => c.url.includes('/roles/')).map(c => `${c.method} ${c.url.split('/members/')[1].slice(0, 3)}`)).toEqual(['DELETE 333', 'PUT 555']);
    quiet();
    expect((await save(await readMember(member.member_id), { discord_user_id: '' })).status).toBe(400);
  });

  it('prevents an old admin form from unlinking a newly completed payment', async () => {
    quiet();
    const member = await insertMember({ email: 'maker@example.com' });
    mockFetch([
      ['GET', 'https://api.stripe.com/v1/customers/cus_paid', { id: 'cus_paid' }],
      ['GET', /\/v1\/subscriptions\?customer=cus_paid/, { data: [{ id: 'sub_paid', status: 'active' }], has_more: false }],
    ]);
    const payment = await call('/webhooks/stripe', await stripeEvent({
      type: 'checkout.session.completed', data: { object: { customer: 'cus_paid', client_reference_id: member.member_id } },
    }));
    expect(payment.status).toBe(204);
    const response = await save(member, { notes: 'An edit from before checkout' });
    expect(response.status).toBe(409);
    expect(await readMember(member.member_id)).toMatchObject({ stripe_customer_id: 'cus_paid', stripe_subscription_state: 'active' });
  });

  it('preserves a payment update that arrives while validating an admin edit', async () => {
    const member = await insertMember({ discord_user_id: '333333333333333333', stripe_customer_id: 'cus_paid', stripe_subscription_id: 'sub_paid', stripe_subscription_state: 'active' });
    const calls = mockFetch([
      ['GET', `${discordAPI}/555555555555555555`, async () => {
        const response = await call('/webhooks/stripe', await stripeEvent({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_paid' } } }));
        expect(response.status).toBe(204);
        return { user: { id: '555555555555555555', username: 'new-account' } };
      }],
      ['GET', 'https://api.stripe.com/v1/customers/cus_paid', { id: 'cus_paid', name: 'Updated Billing Name' }],
      ['GET', /\/v1\/subscriptions\?customer=cus_paid/, { data: [{ id: 'sub_paid', status: 'canceled' }], has_more: false }],
      role('DELETE', '333333333333333333'), role('DELETE', '555555555555555555'), role('PUT', '555555555555555555'),
    ]);
    const response = await save(member, { discord_user_id: '555555555555555555', notes: 'Keep this edit' });
    expect(response.status).toBe(303);
    expect(await readMember(member.member_id)).toMatchObject({ stripe_subscription_state: 'canceled', billing_name: 'Updated Billing Name', notes: 'Keep this edit' });
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('keeps saved edits and reports when Discord synchronization fails', async () => {
    quiet();
    const member = await insertMember({ discord_user_id: '333333333333333333' });
    mockFetch([guildMember('555555555555555555'), role('DELETE', '333333333333333333', 500)]);
    const response = await save(member, { discord_user_id: '555555555555555555' });
    expect(response.headers.get('Location')).toContain('notice=sync_failed');
    expect((await readMember(member.member_id)).discord_user_id).toBe('555555555555555555');
  });

  it('generates shareable checkout links and refuses them for ongoing subscriptions', async () => {
    quiet();
    const member = await insertMember({ email: 'maker@example.com' });
    const checkout = (fields = {}) => call(`/admin/members/${member.member_id}/checkout`, post({
      metadata_version: '0', name_override: 'Unsaved name', notes: '', fob_id: '', discord_user_id: '', stripe_customer_id: '',
      billing: 'monthly', discount_type: '', ...fields,
    }, { Cookie: cookie }));
    let calls = mockFetch([
      ['GET', /\/v1\/prices\?/, { data: [{ id: 'price_1', type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, product: 'prod' }], has_more: false }],
      ['POST', 'https://api.stripe.com/v1/customers', { id: 'cus_1' }],
      ['GET', /\/v1\/checkout\/sessions\?/, { data: [], has_more: false }],
      ['GET', /\/v1\/subscriptions\?/, { data: [], has_more: false }],
      ['POST', 'https://api.stripe.com/v1/checkout/sessions', { url: 'https://checkout.stripe.com/c/pay/cs_1' }],
    ]);
    let response = await checkout();
    let html = await response.text();
    expect(html).toContain('value="https://checkout.stripe.com/c/pay/cs_1"');
    expect(html).toContain('value="Unsaved name"');
    expect(html).toContain('name="metadata_version" value="1"');
    expect(html).toContain('name="stripe_customer_id" type="text" value="cus_1"');
    expect((await readMember(member.member_id)).metadata_version).toBe(1);

    // Unsaved billing choices are used for the link and saved with it.
    vi.restoreAllMocks();
    quiet();
    calls = mockFetch([
      ['GET', /\/v1\/checkout\/sessions\?/, { data: [], has_more: false }],
      ['GET', /\/v1\/subscriptions\?/, { data: [], has_more: false }],
      ['GET', /\/v1\/prices\?/, { data: [{ id: 'price_y', type: 'recurring', recurring: { interval: 'year', interval_count: 1 }, product: 'prod' }], has_more: false }],
      ['GET', /\/v1\/coupons\?/, { data: [{ id: 'coupon_s', valid: true, metadata: { discountTypes: 'student' } }], has_more: false }],
      ['POST', 'https://api.stripe.com/v1/checkout/sessions', { url: 'https://checkout.stripe.com/c/pay/cs_2' }],
    ]);
    response = await checkout({ metadata_version: '1', stripe_customer_id: 'cus_1', billing: 'yearly', discount_type: 'student' });
    html = await response.text();
    expect(html).toContain('value="https://checkout.stripe.com/c/pay/cs_2"');
    expect(html).toContain('name="metadata_version" value="2"');
    const body = new URLSearchParams(calls.at(-1).body);
    expect(body.get('line_items[0][price]')).toBe('price_y');
    expect(body.get('discounts[0][coupon]')).toBe('coupon_s');
    expect(await readMember(member.member_id)).toMatchObject({ bill_annually: 1, discount_type: 'student', name_override: '', metadata_version: 2 });

    // A stale form can't overwrite newer billing choices.
    vi.restoreAllMocks();
    quiet();
    mockFetch();
    response = await checkout({ billing: 'monthly' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('name="metadata_version" value="0"');
    expect(await readMember(member.member_id)).toMatchObject({ bill_annually: 1 });

    vi.restoreAllMocks();
    quiet();
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1'").run();
    mockFetch([
      ['GET', /\/v1\/checkout\/sessions\?/, { data: [], has_more: false }],
      ['GET', /\/v1\/subscriptions\?/, { data: [{ id: 'sub_1', status: 'active' }], has_more: false }],
    ]);
    response = await checkout({ metadata_version: '2', stripe_customer_id: 'cus_1', billing: 'yearly', discount_type: 'student' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('already has an ongoing subscription');
  });

  it('deletes members, revoking Discord and keeping history', async () => {
    const member = await insertMember({ discord_user_id: '333333333333333333' });
    await addWaiver(member.member_id);
    const calls = mockFetch([role('DELETE', '333333333333333333', 404)]);
    const response = await call(`/admin/members/${member.member_id}/delete`, post({}, { Cookie: cookie }));
    expect(response.headers.get('Location')).toBe('/admin');
    expect(calls).toHaveLength(1);
    expect(await readMember(member.member_id)).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM waivers').first()).n).toBe(1);
  });

  it('renders member and global history with event filters', async () => {
    const member = await insertMember({ name_override: 'Maker' });
    await env.DB.prepare('UPDATE members SET notes = ? WHERE member_id = ?').bind('x', member.member_id).run();
    for (const path of ['/admin/events', `/admin/members/${member.member_id}/events`]) {
      let html = await (await get(path)).text();
      expect(html).toContain('2 events.');
      html = await (await get(`${path}?event_type=NotesUpdated`)).text();
      expect(html).toContain('1 event.');
      expect(html).toContain('Internal notes updated.');
    }
    expect((await get('/admin/members/00000000000000000000000000000000')).status).toBe(404);
  });
});
