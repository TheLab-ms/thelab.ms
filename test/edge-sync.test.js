import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { edgeCall, nightlyDate } from '../src/edge-sync.js';
import worker from '../src/index.js';
import { issueToken } from '../src/auth.js';
import { hash } from '../src/http.js';
import { testEdgePrivateKey } from './edge-auth-helpers.js';

const configured = { ...env, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
const stub = () => env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge'));
let goal, swipes, writes, fetchSpy;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await runInDurableObject(stub(), instance => {
    instance.env = { ...instance.env, ...configured };
  });
  goal = null; swipes = []; writes = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    if (String(url).startsWith('https://discord.com/')) return Response.json({ roles: [env.DISCORD_ADMIN_ROLE_ID] });
    expect(init.redirect).toBe('manual');
    expect(init.headers.Authorization).toMatch(/^Bearer ey/);
    expect(init.headers['CF-Access-Client-Secret']).toBeUndefined();
    if (String(url).endsWith('/api/swipes')) return Response.json(swipes);
    expect(String(url)).toBe('https://edge.example/api/goal');
    if (init.method === 'GET') return goal ? Response.json(goal) : new Response(null, { status: 503 });
    const body = JSON.parse(init.body); writes.push({ method: init.method, ...body });
    if (init.method === 'PUT') goal = body;
    else {
      expect(body.base_version).toBe(goal.version);
      goal = { version: body.version, fobs: [...goal.fobs.filter(id => !body.remove.includes(id)), ...body.add].sort((a, b) => a - b) };
    }
    return new Response(null, { status: 204 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function member(fob = 7, status = 'active', waiver = true) {
  const row = await env.DB.prepare('INSERT INTO members(fob_id, stripe_subscription_state) VALUES (?, ?) RETURNING *').bind(fob, status).first();
  if (waiver) await env.DB.prepare(`INSERT INTO waivers(member_id, version, content, name, email, agreements) VALUES (?, 1, 'Terms', 'Maker', 'maker@example.com', '[]')`).bind(row.member_id).run();
  return row;
}

it('requires active AND a signed waiver; pushes diffs for changes and empty revocation', async () => {
  const active = await member();
  await member(8, 'trialing');
  const unsigned = await member(9, 'active', false);
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual([7]);
  await edgeCall(configured, 'changes');
  expect(writes).toHaveLength(1);
  await env.DB.prepare(`UPDATE members SET stripe_subscription_state = 'past_due' WHERE member_id = ?`).bind(active.member_id).run();
  await edgeCall(configured, 'changes');
  expect(writes[1]).toMatchObject({ method: 'PATCH', add: [], remove: [7] });
  expect(goal.fobs).toEqual([]);
  await env.DB.prepare(`INSERT INTO waivers(member_id, version, content, name, email, agreements) VALUES (?, 1, 'Terms', 'Maker', 'maker@example.com', '[]')`).bind(unsigned.member_id).run();
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual([9]);
  await expect(env.DB.prepare('UPDATE members SET fob_id = 9 WHERE member_id = ?').bind(active.member_id).run()).rejects.toThrow();
});

it('shows the same admin fob status as edge eligibility across Stripe states, waivers, and overrides', async () => {
  const expected = [], members = [];
  let fob = 100;
  for (const status of [null, 'active', 'trialing', 'past_due', 'canceled']) {
    for (const signed of [false, true, 'legacy']) {
      for (const [nonBillable, legacyBilling] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const m = await member(fob++, status, signed === true);
        members.push(m);
        await env.DB.prepare('UPDATE members SET non_billable = ?, legacy_billing = ?, legacy_waiver_signed = ? WHERE member_id = ?')
          .bind(nonBillable, legacyBilling, Number(signed === 'legacy'), m.member_id).run();
        if (nonBillable || (signed && (legacyBilling || status === 'active'))) expected.push(m.fob_id);
      }
    }
  }
  const unassigned = await member(null, null, false);
  members.push(unassigned);
  await env.DB.prepare('UPDATE members SET non_billable = 1, legacy_billing = 1 WHERE member_id = ?').bind(unassigned.member_id).run();
  await edgeCall(configured, 'full');
  expect(goal.fobs).toEqual(expected);
  const token = await issueToken(env, '333333333333333333', 'admin');
  for (const m of members) {
    const response = await worker.fetch(new Request(`${env.SITE_URL}/admin/members/${m.member_id}`, {
      headers: { Cookie: `thelab_admin=${token}` },
    }), configured);
    expect(response.status).toBe(200);
    const html = await response.text();
    const enabled = goal.fobs.includes(m.fob_id);
    expect(html).toContain(`admin-status--${enabled ? 'active' : 'inactive'}">Fob ${enabled ? 'enabled' : 'disabled'}</span>`);
    if (!m.fob_id) expect(html).toContain('No fob assigned.');
  }
});

it('synchronizes imported waiver eligibility changes without creating signature records', async () => {
  const m = await member(7, 'active', false);
  await edgeCall(configured, 'full');
  expect(goal.fobs).toEqual([]);
  await env.DB.prepare('UPDATE members SET legacy_waiver_signed = 1 WHERE member_id = ?').bind(m.member_id).run();
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual([7]);
  expect(await env.DB.prepare('SELECT count(*) AS count FROM waivers').first()).toEqual({ count: 0 });
  const token = await issueToken(env, '333333333333333333', 'admin');
  const response = await worker.fetch(new Request(`${env.SITE_URL}/admin/members/${m.member_id}`, {
    headers: { Cookie: `thelab_admin=${token}` },
  }), configured);
  expect(await response.text()).toContain('Conway recorded a signed waiver.');
  await env.DB.prepare('UPDATE members SET legacy_waiver_signed = 0 WHERE member_id = ?').bind(m.member_id).run();
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual([]);
});

it('saves access checkboxes, records history, and immediately adds or removes fobs', async () => {
  const m = await member(7, null, false);
  const read = () => env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(m.member_id).first();
  await runInDurableObject(env.MEMBERS.get(env.MEMBERS.idFromName(m.member_id)), instance => {
    instance.env = { ...instance.env, ...configured };
  });
  const token = await issueToken(env, '333333333333333333', 'admin');
  const cookie = `thelab_admin=${token}`;
  const path = `${env.SITE_URL}/admin/members/${m.member_id}`;
  const get = async (url = path) => (await worker.fetch(new Request(url, { headers: { Cookie: cookie } }), configured)).text();
  const save = async (extra = {}) => worker.fetch(new Request(path, {
    method: 'POST', headers: { Cookie: cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: await hash(`admin-csrf:${token}`), metadata_version: String((await read()).metadata_version),
      discord_user_id: '', stripe_customer_id: '', stripe_subscription_id: '', name_override: '', notes: '',
      billing: 'monthly', discount_type: '', fob_id: '7', ...extra }),
  }), configured);
  const checked = name => new RegExp(`name="${name}" type="checkbox" checked`);
  expect(await read()).toMatchObject({ non_billable: 0, legacy_billing: 0 });
  expect(await get()).not.toMatch(checked('non_billable'));
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual([]);

  expect((await save({ non_billable: 'on', legacy_billing: 'on' })).status).toBe(303);
  expect(goal.fobs).toEqual([7]);
  expect(writes.at(-1)).toMatchObject({ method: 'PATCH', add: [7], remove: [] });
  expect(await read()).toMatchObject({ non_billable: 1, legacy_billing: 1 });
  const html = await get();
  expect(html).toContain('>Fob enabled</span>');
  expect(html).toMatch(checked('non_billable'));
  expect(html).toMatch(checked('legacy_billing'));
  expect(html).toContain('Disabled → Enabled');
  const list = await get(`${env.SITE_URL}/admin`);
  expect(list).toContain('<small>Non-billable</small>');
  expect(list).toContain('<small>Legacy billing</small>');

  const stale = await save({ metadata_version: '0', legacy_billing: 'on' });
  expect(stale.status).toBe(409);
  const staleHTML = await stale.text();
  expect(staleHTML).toContain('>Fob enabled</span>');
  expect(staleHTML).not.toMatch(checked('non_billable'));
  expect(staleHTML).toMatch(checked('legacy_billing'));
  expect(goal.fobs).toEqual([7]);
  for (const key of ['non_billable', 'legacy_billing']) {
    expect((await save({ [key]: 'false' })).status).toBe(400);
  }
  expect(await read()).toMatchObject({ non_billable: 1, legacy_billing: 1 });

  expect((await save({ legacy_billing: 'on' })).status).toBe(303);
  expect(await get()).toContain('>Fob disabled</span>');
  expect(writes.at(-1)).toMatchObject({ method: 'PATCH', add: [], remove: [7] });
  expect(goal.fobs).toEqual([]);
  await env.DB.prepare(`INSERT INTO waivers(member_id, version, content, name, email, agreements)
    VALUES (?, 1, 'Terms', 'Maker', 'maker@example.com', '[]')`).bind(m.member_id).run();
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual([7]);
  expect(await get()).toContain('>Fob enabled</span>');
  expect((await save()).status).toBe(303);
  expect(goal.fobs).toEqual([]);
  expect(await read()).toMatchObject({ non_billable: 0, legacy_billing: 0 });
  const revision = await env.DB.prepare('SELECT revision FROM edge_changes').first();
  expect((await save()).status).toBe(303);
  expect(await env.DB.prepare('SELECT revision FROM edge_changes').first()).toEqual(revision);
  const { results } = await env.DB.prepare(`SELECT event_type, details FROM member_events
    WHERE event_type IN ('NonBillableChanged', 'LegacyBillingChanged') ORDER BY id`).all();
  expect(results).toEqual([
    { event_type: 'NonBillableChanged', details: '{"from":0,"to":1}' },
    { event_type: 'LegacyBillingChanged', details: '{"from":0,"to":1}' },
    { event_type: 'NonBillableChanged', details: '{"from":1,"to":0}' },
    { event_type: 'LegacyBillingChanged', details: '{"from":1,"to":0}' },
  ]);
});

it('recovers ambiguous delivery from edge state and keeps later revisions pending', async () => {
  const m = await member();
  await edgeCall(configured, 'changes');
  await env.DB.prepare('UPDATE members SET fob_id = 10 WHERE member_id = ?').bind(m.member_id).run();
  const normal = fetchSpy.getMockImplementation();
  fetchSpy.mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    if (init.method === 'PATCH') {
      await env.DB.prepare('UPDATE members SET fob_id = 11 WHERE member_id = ?').bind(m.member_id).run();
      throw new Error('Connection lost after commit');
    }
    return response;
  });
  await expect(edgeCall(configured, 'changes')).rejects.toThrow();
  expect(goal.fobs).toEqual([10]);
  fetchSpy.mockImplementation(normal);
  await runDurableObjectAlarm(stub());
  expect(goal.fobs).toEqual([11]);
  expect(goal.version).toBeGreaterThan(writes[1].version);
});

it('deduplicates swipe backups and uses ownership at swipe time after reassignment', async () => {
  const first = await member();
  await env.DB.prepare('UPDATE fob_assignments SET started = 1000 WHERE member_id = ?').bind(first.member_id).run();
  await env.DB.prepare('UPDATE members SET fob_id = NULL WHERE member_id = ?').bind(first.member_id).run();
  await env.DB.prepare('UPDATE fob_assignments SET ended = 2000 WHERE member_id = ?').bind(first.member_id).run();
  const second = await member();
  await env.DB.prepare('UPDATE fob_assignments SET started = 2000 WHERE member_id = ?').bind(second.member_id).run();
  swipes = [1500, 2500].map((time, i) => ({ id: `swipe-${i}`, time: new Date(time * 1000).toISOString(), fob: 7, allowed: true, controller: '192.168.1.2' }));
  swipes.push({ ...swipes[0], id: 'unknown', fob: 99, allowed: false });
  await edgeCall(configured, 'swipes');
  await edgeCall(configured, 'swipes');
  const { results } = await env.DB.prepare('SELECT id, member_id FROM edge_swipes ORDER BY id').all();
  expect(results).toEqual([{ id: 'swipe-0', member_id: first.member_id }, { id: 'swipe-1', member_id: second.member_id }, { id: 'unknown', member_id: null }]);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM member_events WHERE event_type = 'FobSwipe'").first()).n).toBe(3);
});

it('renders cached swipes across admin pages without contacting edgeproxy', async () => {
  const m = await member();
  await env.DB.prepare('UPDATE fob_assignments SET started = 1000 WHERE member_id = ?').bind(m.member_id).run();
  swipes = [{ id: 'cached', fob: 7, allowed: true, controller: '192.168.1.2', time: new Date().toISOString() }];
  await edgeCall(configured, 'swipes');
  const token = await issueToken(env, '333333333333333333', 'admin');
  const execute = vi.fn(async () => ({ ok: false, error: 'Edgeproxy is unavailable.' }));
  const uiEnv = { ...configured, EDGE_SYNC: { idFromName: () => 'edge', get: () => ({ execute }) } };
  for (const path of ['/admin', '/admin/events', '/admin/events?event_type=FobSwipe',
    `/admin/members/${m.member_id}`, `/admin/members/${m.member_id}/events`, `/admin/members/${m.member_id}/events?event_type=FobSwipe`]) {
    const response = await worker.fetch(new Request(`${env.SITE_URL}${path}`, { headers: { Cookie: `thelab_admin=${token}` } }), uiEnv);
    expect(response.status).toBe(200);
    const html = await response.text();
    if (path !== '/admin') expect(html).toContain('Fob 7');
    expect(html).toMatch(/<header\b[^>]*>.*>Sync Cache<\/button>.*>Log Out<\/button>.*<\/header>/s);
  }
  expect(execute).not.toHaveBeenCalled();
});

it('protects manual full sync with an admin session and CSRF; sends a full snapshot', async () => {
  await member();
  const token = await issueToken(env, '333333333333333333', 'admin');
  const admin = await worker.fetch(new Request(`${env.SITE_URL}/admin`, { headers: { Cookie: `thelab_admin=${token}` } }), configured);
  expect(admin.headers.get('Referrer-Policy')).toBe('same-origin');
  const html = await admin.text();
  expect(html).toMatch(/<header\b[^>]*>.*action="\/admin\/edge\/resync".*>Sync Cache<\/button>.*action="\/admin\/logout".*<\/header>/s);
  expect(html).not.toContain('<h2>Door access</h2>');
  const disabled = await worker.fetch(new Request(`${env.SITE_URL}/admin`, { headers: { Cookie: `thelab_admin=${token}` } }), { ...configured, EDGE_URL: '' });
  expect(await disabled.text()).not.toContain('Sync Cache');
  const request = csrf => new Request(`${env.SITE_URL}/admin/edge/resync`, { method: 'POST', headers: {
    Cookie: `thelab_admin=${token}`, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf }) });
  expect((await worker.fetch(request('wrong'), configured)).status).toBe(403);
  expect(writes).toHaveLength(0);
  const csrf = await hash(`admin-csrf:${token}`);
  swipes = [{ id: 'manual', fob: 7, allowed: true, controller: '192.168.1.2', time: new Date().toISOString() }];
  expect((await worker.fetch(request(csrf), configured)).status).toBe(200);
  expect(writes[0]).toMatchObject({ method: 'PUT', fobs: [7] });
  expect(await env.DB.prepare('SELECT id FROM edge_swipes').all()).toMatchObject({ results: [{ id: 'manual' }] });
  expect(fetchSpy.mock.calls.some(([url]) => String(url).startsWith('https://discord.com/'))).toBe(false);
  const invalid = request(csrf);
  invalid.headers.set('Cookie', `thelab_admin=${await issueToken(env, '333333333333333333', 'member')}`);
  expect((await worker.fetch(invalid, configured)).status).toBe(303);
  expect(writes).toHaveLength(1);
});

it.each([
  [null, 'missing'],
  ['null', 'null (opaque origin; check the page Referrer-Policy)'],
  ['https://elsewhere.example', 'https://elsewhere.example'],
  ['https://private-user:private-password@elsewhere.example/private-path?code=private-code', 'https://elsewhere.example'],
  ['malformed-private-header', 'invalid'],
])('explains rejected full-sync origins in traces without exposing request secrets: %s', async (origin, received) => {
  const token = await issueToken(env, '333333333333333333', 'admin');
  const csrf = await hash(`admin-csrf:${token}`);
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const headers = new Headers({ Cookie: `thelab_admin=${token}`, 'Content-Type': 'application/x-www-form-urlencoded' });
  if (origin !== null) headers.set('Origin', origin);
  const response = await worker.fetch(new Request(`${env.SITE_URL}/admin/edge/resync?code=private-query`, {
    method: 'POST', headers, body: new URLSearchParams({ csrf, notes: 'private-body' }),
  }), configured);
  expect(response.status).toBe(403);
  expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
  expect(await response.text()).toContain('The form’s origin could not be verified');
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
  expect(log).toHaveBeenCalledTimes(1);
  const entry = JSON.parse(log.mock.calls[0][0]);
  expect(entry).toMatchObject({ event: 'admin.failed', path: '/admin/edge/resync', method: 'POST', status: 403,
    error: { cause: { message: `Admin form Origin check failed: expected ${env.SITE_URL}; received ${received}. Request rejected before performing the admin action.` } } });
  const trace = JSON.stringify(entry);
  for (const secret of [token, csrf, 'private-user', 'private-password', 'private-path', 'private-code', 'private-query', 'private-body', 'malformed-private-header']) {
    expect(trace).not.toContain(secret);
  }
});

it('preserves rejected admin edits without refreshing swipes', async () => {
  const m = await member();
  const token = await issueToken(env, '333333333333333333', 'admin');
  const normal = fetchSpy.getMockImplementation();
  fetchSpy.mockImplementation((url, init) => String(url).endsWith('/api/swipes')
    ? new Response(null, { status: 502 }) : normal(url, init));
  const response = await worker.fetch(new Request(`${env.SITE_URL}/admin/members/${m.member_id}`, {
    method: 'POST', headers: { Cookie: `thelab_admin=${token}`, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: await hash(`admin-csrf:${token}`), metadata_version: '0',
      discord_user_id: '', stripe_customer_id: '', stripe_subscription_id: '', name_override: 'Unsaved maker',
      notes: 'Keep my draft <please>', billing: 'monthly', discount_type: '', fob_id: '7' }),
  }), configured);
  expect(response.status).toBe(409);
  const html = await response.text();
  expect(html).toContain('value="Unsaved maker"');
  expect(html).toContain('Keep my draft &lt;please&gt;');
  expect(html).not.toContain('Could not refresh swipes');
  expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/swipes'))).toHaveLength(0);
  expect((await env.DB.prepare('SELECT notes FROM members WHERE member_id = ?').bind(m.member_id).first()).notes).toBe('');
});

it('backs up nightly once per Central date, including the repeated fall-back hour', async () => {
  expect(nightlyDate(Date.parse('2026-01-15T07:00:00Z'))).toBe('2026-01-15');
  expect(nightlyDate(Date.parse('2026-07-15T06:00:00Z'))).toBe('2026-07-15');
  expect(nightlyDate(Date.parse('2026-07-15T07:00:00Z'))).toBeNull();
  for (const time of ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z']) {
    expect(nightlyDate(Date.parse(time))).toBe('2026-11-01');
    await worker.scheduled({ scheduledTime: Date.parse(time) }, configured);
  }
  expect(writes).toHaveLength(1);
  expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/swipes'))).toHaveLength(1);
});

it('retries partially imported batches without duplicating swipe history', async () => {
  swipes = Array.from({ length: 101 }, (_, i) => ({ id: `batch-${i}`, time: new Date().toISOString(), controller: '192.168.1.2', fob: 7, allowed: true }));
  await env.DB.exec(`CREATE TRIGGER fail_swipe BEFORE INSERT ON edge_swipes WHEN NEW.id = 'batch-100' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  await expect(edgeCall(configured, 'swipes')).rejects.toThrow();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(100);
  await env.DB.exec('DROP TRIGGER fail_swipe');
  await edgeCall(configured, 'swipes');
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM member_events WHERE event_type = 'FobSwipe'").first()).n).toBe(101);
});

it('keeps nightly work pending after failure and retries both operations', async () => {
  await member();
  const normal = fetchSpy.getMockImplementation();
  fetchSpy.mockImplementation((url, init) => String(url).endsWith('/api/swipes') ? new Response(null, { status: 502 }) : normal(url, init));
  await expect(edgeCall(configured, 'nightly', '2026-09-13')).rejects.toThrow();
  expect(goal.fobs).toEqual([7]);
  await runInDurableObject(stub(), async (_instance, ctx) => {
    expect(await ctx.storage.get('nightlyDone')).toBeUndefined();
    expect(await ctx.storage.get('fullPending')).toEqual({ date: '2026-09-13' });
  });
  fetchSpy.mockImplementation(normal);
  await runDurableObjectAlarm(stub());
  await runInDurableObject(stub(), async (_instance, ctx) => {
    expect(await ctx.storage.get('nightlyDone')).toBe('2026-09-13');
    expect(await ctx.storage.get('fullPending')).toBeUndefined();
  });
});

it('rejects malformed swipe payloads before importing any rows', async () => {
  swipes = [{ id: 'valid', time: new Date().toISOString(), controller: '192.168.1.2', fob: 7, allowed: true },
    { id: 'invalid', time: 'yesterday', controller: '192.168.1.2', fob: 0, allowed: 'yes' }];
  await expect(edgeCall(configured, 'swipes')).rejects.toThrow();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(0);
});

it('delivers all 512 authorized fobs and rejects overflow without truncating the goal', async () => {
  await env.DB.prepare(`INSERT INTO members(fob_id, non_billable)
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<512)
    SELECT n, 1 FROM seq`).run();
  await edgeCall(configured, 'changes');
  expect(goal.fobs).toEqual(Array.from({ length: 512 }, (_, i) => i + 1));
  await env.DB.prepare('INSERT INTO members(fob_id, non_billable) VALUES (513, 1)').run();
  await expect(edgeCall(configured, 'changes')).rejects.toMatchObject({ status: 503 });
  expect(writes).toHaveLength(1);
  expect(goal.fobs).toHaveLength(512);
  await env.DB.prepare('UPDATE members SET non_billable = 0 WHERE fob_id = 1').run();
  await runDurableObjectAlarm(stub());
  expect(goal.fobs).toEqual(Array.from({ length: 512 }, (_, i) => i + 2));
});

it('rejects an oversized swipe response before importing and recovers on retry', async () => {
  const normal = fetchSpy.getMockImplementation();
  fetchSpy.mockImplementation(async () => new Response('[]', { headers: { 'Content-Length': String(32 * 1024 * 1024 + 1) } }));
  await expect(edgeCall(configured, 'swipes')).rejects.toMatchObject({ status: 503 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(0);
  fetchSpy.mockImplementation(normal);
  expect(await edgeCall(configured, 'swipes')).toEqual({ fetched: 0 });
});
