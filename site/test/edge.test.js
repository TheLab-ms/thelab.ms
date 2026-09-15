import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeSync, cleanupFobClaims, coordinated, edgeCall, fobClaim, nightlyDate } from '../src/membership.js';
import worker, { processMessage } from '../src/index.js';
import { edgeJWKS, edgeToken, hash, issueToken, loginDestination, memberToken, now, randomToken, verifyOAuthState, verifyToken } from '../src/services.js';

// RFC 8032 test seed in PKCS#8; public test material, never a deployment key.
const testEdgePrivateKey = 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g';

describe('Edge synchronization', () => {
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
      expect(String(url)).toBe('https://edge.example/api/goal');
      if (init.method === 'GET') return goal ? Response.json(goal) : new Response(null, { status: 503 });
      const body = JSON.parse(init.body); writes.push({ method: init.method, ...body });
      if (init.method === 'PUT') goal = body;
      else {
        expect(body.base_version).toBe(goal.version);
        goal = { ...goal, version: body.version, fobs: [...goal.fobs.filter(id => !body.remove.includes(id)), ...body.add].sort((a, b) => a - b) };
      }
      return new Response(null, { status: 204 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function signedRequest(text = JSON.stringify(swipes), options = {}) {
    if (!goal) await edgeCall(configured, 'changes');
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const secret = options.key || goal.event_signing_key;
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key,
      new TextEncoder().encode(`POST\n/webhooks/edge/swipes\n${timestamp}\n${text}`))), n => n.toString(16).padStart(2, '0')).join('');
    return new Request(`${env.SITE_URL}/webhooks/edge/swipes`, { method: 'POST', body: text,
      headers: { 'X-Edge-Timestamp': timestamp, 'X-Edge-Signature': signature, 'Content-Type': 'application/json' } });
  }

  async function pushSwipes() {
    const response = await worker.fetch(await signedRequest(), configured);
    if (response.status !== 204) throw Object.assign(new Error('Swipe push failed'), { status: response.status });
  }

  async function member(fob = 7, status = 'active', waiver = true) {
    const row = await env.DB.prepare('INSERT INTO members(fob_id, stripe_subscription_state) VALUES (?, ?) RETURNING *').bind(fob, status).first();
    if (waiver) await env.DB.prepare(`INSERT INTO waivers(member_id, version, content, name, email, agreements) VALUES (?, 1, 'Terms', 'Maker', 'maker@example.com', '[]')`).bind(row.member_id).run();
    return row;
  }

  it('goes idle after immediate and unchanged syncs, and wakes for the next change', async () => {
    const m = await member();
    await edgeCall(configured, 'changes');
    expect(goal.fobs).toEqual([7]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
    fetchSpy.mockClear();
    await edgeCall(configured, 'changes');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await runDurableObjectAlarm(stub())).toBe(false);
    await env.DB.prepare('UPDATE members SET fob_id = 8 WHERE member_id = ?').bind(m.member_id).run();
    await edgeCall(configured, 'changes');
    expect(goal.fobs).toEqual([8]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('keeps retrying an offline edge, then cancels the alarm on recovery', async () => {
    await member();
    const normal = fetchSpy.getMockImplementation();
    fetchSpy.mockRejectedValue(new Error('Edge offline'));
    await expect(edgeCall(configured, 'changes')).rejects.toThrow();
    for (let retry = 0; retry < 2; retry++) {
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      await runInDurableObject(stub(), async (_instance, ctx) => {
        const delay = await ctx.storage.getAlarm() - Date.now();
        expect(delay).toBeGreaterThan(50000);
        expect(delay).toBeLessThanOrEqual(60000);
      });
    }
    fetchSpy.mockImplementation(normal);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(goal.fobs).toEqual([7]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('arms recovery before a failed D1 revision read', async () => {
    await member();
    await env.DB.exec('ALTER TABLE edge_changes RENAME TO unavailable_edge_changes');
    await expect(edgeCall(configured, 'changes')).rejects.toThrow();
    await env.DB.exec('ALTER TABLE unavailable_edge_changes RENAME TO edge_changes');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(goal.fobs).toEqual([7]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('reconciles once for a legacy alarm and stops polling', async () => {
    const m = await member();
    await edgeCall(configured, 'changes');
    await env.DB.prepare('UPDATE members SET fob_id = 8 WHERE member_id = ?').bind(m.member_id).run();
    await runInDurableObject(stub(), async (_instance, ctx) => ctx.storage.setAlarm(Date.now() + 60000));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(goal.fobs).toEqual([8]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('retains a newer revision committed during successful delivery until it is synced', async () => {
    const m = await member();
    const normal = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (init.method === 'PUT') await env.DB.prepare('UPDATE members SET fob_id = 8 WHERE member_id = ?').bind(m.member_id).run();
      return response;
    });
    await edgeCall(configured, 'changes');
    expect(goal.fobs).toEqual([7]);
    fetchSpy.mockImplementation(normal);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(goal.fobs).toEqual([8]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('serializes a change notification arriving during delivery and finishes idle', async () => {
    const m = await member();
    const normal = fetchSpy.getMockImplementation();
    // Keep the deliberately blocked promises in the same DO I/O context.
    await runInDurableObject(stub(), async instance => {
      let release, started;
      const blocked = new Promise(resolve => { release = resolve; });
      const delivering = new Promise(resolve => { started = resolve; });
      fetchSpy.mockImplementation(async (url, init) => {
        const response = await normal(url, init);
        if (init.method === 'PUT') { started(); await blocked; }
        return response;
      });
      const first = instance.execute('changes');
      await delivering;
      await instance.env.DB.prepare('UPDATE members SET fob_id = 8 WHERE member_id = ?').bind(m.member_id).run();
      const second = instance.execute('changes');
      release();
      expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    });
    expect(goal.fobs).toEqual([8]);
    expect(writes.map(write => write.method)).toEqual(['PUT', 'PATCH']);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('honors a pending full snapshot when an ordinary change arrives', async () => {
    const m = await member();
    await edgeCall(configured, 'changes');
    const normal = fetchSpy.getMockImplementation();
    fetchSpy.mockRejectedValue(new Error('Edge offline'));
    await expect(edgeCall(configured, 'nightly', '2026-09-13')).rejects.toThrow();
    await env.DB.prepare('UPDATE members SET fob_id = 8 WHERE member_id = ?').bind(m.member_id).run();
    fetchSpy.mockImplementation(normal);
    await edgeCall(configured, 'changes');
    expect(writes.at(-1)).toMatchObject({ method: 'PUT', fobs: [8] });
    await runInDurableObject(stub(), async (_instance, ctx) => {
      expect(await ctx.storage.get('nightlyDone')).toBe('2026-09-13');
      expect(await ctx.storage.get('fullPending')).toBeUndefined();
    });
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it.each(['active', 'trialing'])('allows %s with a signed waiver; pushes diffs for changes and empty revocation', async status => {
    const subscribed = await member(7, status);
    await member(8, 'past_due');
    const unsigned = await member(9, status, false);
    await edgeCall(configured, 'changes');
    expect(goal.fobs).toEqual([7]);
    await edgeCall(configured, 'changes');
    expect(writes).toHaveLength(1);
    await env.DB.prepare(`UPDATE members SET stripe_subscription_state = 'past_due' WHERE member_id = ?`).bind(subscribed.member_id).run();
    await edgeCall(configured, 'changes');
    expect(writes[1]).toMatchObject({ method: 'PATCH', add: [], remove: [7] });
    expect(goal.fobs).toEqual([]);
    await env.DB.prepare(`INSERT INTO waivers(member_id, version, content, name, email, agreements) VALUES (?, 1, 'Terms', 'Maker', 'maker@example.com', '[]')`).bind(unsigned.member_id).run();
    await edgeCall(configured, 'changes');
    expect(goal.fobs).toEqual([9]);
    await expect(env.DB.prepare('UPDATE members SET fob_id = 9 WHERE member_id = ?').bind(subscribed.member_id).run()).rejects.toThrow();
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
          if (nonBillable || (signed && (legacyBilling || status === 'active' || status === 'trialing'))) expected.push(m.fob_id);
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
    const list = await get(`${env.SITE_URL}/admin?waiver=all&discord=all`);
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
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('deduplicates pushed swipes and uses ownership at swipe time after reassignment', async () => {
    const first = await member();
    await env.DB.prepare('UPDATE fob_assignments SET started = 1000 WHERE member_id = ?').bind(first.member_id).run();
    await env.DB.prepare('UPDATE members SET fob_id = NULL WHERE member_id = ?').bind(first.member_id).run();
    await env.DB.prepare('UPDATE fob_assignments SET ended = 2000 WHERE member_id = ?').bind(first.member_id).run();
    const second = await member();
    await env.DB.prepare('UPDATE fob_assignments SET started = 2000 WHERE member_id = ?').bind(second.member_id).run();
    swipes = [1500, 2500].map((time, i) => ({ id: `swipe-${i}`, time: new Date(time * 1000).toISOString(), fob: 7, allowed: true, controller: '192.168.1.2' }));
    swipes.push({ ...swipes[0], id: 'unknown', fob: 99, allowed: false });
    await pushSwipes();
    await pushSwipes();
    const { results } = await env.DB.prepare('SELECT id, member_id FROM edge_swipes ORDER BY id').all();
    expect(results).toEqual([{ id: 'swipe-0', member_id: first.member_id }, { id: 'swipe-1', member_id: second.member_id }, { id: 'unknown', member_id: null }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM member_events WHERE event_type = 'FobSwipe'").first()).n).toBe(3);
  });

  it('renders cached swipes across admin pages without contacting edgeproxy', async () => {
    const m = await member();
    await env.DB.prepare('UPDATE fob_assignments SET started = 1000 WHERE member_id = ?').bind(m.member_id).run();
    swipes = [{ id: 'cached', fob: 7, allowed: true, controller: '192.168.1.2', time: new Date().toISOString() }];
    await pushSwipes();
    const token = await issueToken(env, '333333333333333333', 'admin');
    const execute = vi.fn(async () => ({ ok: false, error: 'Edgeproxy is unavailable.' }));
    const uiEnv = { ...configured, EDGE_SYNC: { idFromName: () => 'edge', get: () => ({ execute }) } };
    for (const path of ['/admin', '/admin/events', '/admin/events?event_type=FobSwipe',
      `/admin/members/${m.member_id}`, `/admin/members/${m.member_id}/events`, `/admin/members/${m.member_id}/events?event_type=FobSwipe`]) {
      const response = await worker.fetch(new Request(`${env.SITE_URL}${path}`, { headers: { Cookie: `thelab_admin=${token}` } }), uiEnv);
      expect(response.status).toBe(200);
      const html = await response.text();
      if (path !== '/admin') expect(html).toContain('Fob 7');
      expect(html).toMatch(/<header\b[^>]*>.*>Log Out<\/button>.*<\/header>/s);
      expect(html).not.toContain('Sync Cache');
      expect(html).not.toContain('/admin/edge/resync');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('removes browser-triggered sync even for signed-in admins', async () => {
    await member();
    const token = await issueToken(env, '333333333333333333', 'admin');
    for (const method of ['GET', 'POST']) {
      const response = await worker.fetch(new Request(`${env.SITE_URL}/admin/edge/resync`, { method, headers: {
        Cookie: `thelab_admin=${token}`, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded',
      }, ...(method === 'POST' ? { body: new URLSearchParams({ csrf: await hash(`admin-csrf:${token}`) }) } : {}) }), configured);
      expect(response.status).toBe(404);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('accepts operator full-sync queue messages and safely handles redelivery', async () => {
    await member();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const message = { id: 'operator-sync', body: { type: 'edge.sync', mode: 'full' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    for (let delivery = 0; delivery < 2; delivery++) {
      await worker.queue({ messages: [message] }, configured);
      expect(writes[delivery]).toMatchObject({ method: 'PUT', fobs: [7] });
      expect(await runDurableObjectAlarm(stub())).toBe(false);
    }
    expect(message.ack).toHaveBeenCalledTimes(2);
    expect(message.retry).not.toHaveBeenCalled();
    expect(writes[1].version).toBeGreaterThan(writes[0].version);
    expect(writes[1].event_signing_key).toBe(writes[0].event_signing_key);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'edge.full.completed', date: null }));
  });

  it('retries failed operator queue messages and acknowledges only successful delivery', async () => {
    await member();
    const normal = fetchSpy.getMockImplementation();
    fetchSpy.mockRejectedValue(new Error('Edge offline'));
    const message = { id: 'operator-sync', body: { type: 'edge.sync', mode: 'full' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] }, configured);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    fetchSpy.mockImplementation(normal);
    await worker.queue({ messages: [message] }, configured);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(goal.fobs).toEqual([7]);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it.each([
    { type: 'edge.sync' }, { type: 'edge.sync', mode: 'changes' }, { type: 'unknown', mode: 'full' },
    { type: 'edge.sync', mode: 'full', customer_id: 'cus_unrelated' },
  ])('rejects malformed operator messages: %j', async body => {
    await expect(processMessage(body, configured)).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'missing'],
    ['null', 'null (opaque origin; check the page Referrer-Policy)'],
    ['https://elsewhere.example', 'https://elsewhere.example'],
    ['https://private-user:private-password@elsewhere.example/private-path?code=private-code', 'https://elsewhere.example'],
    ['malformed-private-header', 'invalid'],
  ])('explains rejected admin form origins in traces without exposing request secrets: %s', async (origin, received) => {
    const token = await issueToken(env, '333333333333333333', 'admin');
    const csrf = await hash(`admin-csrf:${token}`);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const headers = new Headers({ Cookie: `thelab_admin=${token}`, 'Content-Type': 'application/x-www-form-urlencoded' });
    if (origin !== null) headers.set('Origin', origin);
    const response = await worker.fetch(new Request(`${env.SITE_URL}/admin/logout?code=private-query`, {
      method: 'POST', headers, body: new URLSearchParams({ csrf, notes: 'private-body' }),
    }), configured);
    expect(response.status).toBe(403);
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(await response.text()).toContain('The form’s origin could not be verified');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(log.mock.calls[0][0]);
    expect(entry).toMatchObject({ event: 'admin.failed', path: '/admin/logout', method: 'POST', status: 403,
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

  it('syncs goals nightly once per Central date, including the repeated fall-back hour', async () => {
    expect(nightlyDate(Date.parse('2026-01-15T07:00:00Z'))).toBe('2026-01-15');
    expect(nightlyDate(Date.parse('2026-07-15T06:00:00Z'))).toBe('2026-07-15');
    expect(nightlyDate(Date.parse('2026-07-15T07:00:00Z'))).toBeNull();
    for (const time of ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z']) {
      expect(nightlyDate(Date.parse(time))).toBe('2026-11-01');
      await worker.scheduled({ scheduledTime: Date.parse(time) }, configured);
    }
    expect(writes).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/swipes'))).toHaveLength(0);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('retries partially imported batches without duplicating swipe history', async () => {
    swipes = Array.from({ length: 101 }, (_, i) => ({ id: `batch-${i}`, time: new Date().toISOString(), controller: '192.168.1.2', fob: 7, allowed: true }));
    await env.DB.exec(`CREATE TRIGGER fail_swipe BEFORE INSERT ON edge_swipes WHEN NEW.id = 'batch-100' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await expect(pushSwipes()).rejects.toMatchObject({ status: 500 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(100);
    await env.DB.exec('DROP TRIGGER fail_swipe');
    await pushSwipes();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM member_events WHERE event_type = 'FobSwipe'").first()).n).toBe(101);
  });

  it('keeps nightly goal work pending after failure and retries', async () => {
    await member();
    const normal = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation(() => new Response(null, { status: 502 }));
    await expect(edgeCall(configured, 'nightly', '2026-09-13')).rejects.toThrow();
    expect(goal).toBeNull();
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
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it('rejects malformed swipe payloads before importing any rows', async () => {
    swipes = [{ id: 'valid', time: new Date().toISOString(), controller: '192.168.1.2', fob: 7, allowed: true },
      { id: 'invalid', time: 'yesterday', controller: '192.168.1.2', fob: 0, allowed: 'yes' }];
    await expect(pushSwipes()).rejects.toMatchObject({ status: 400 });
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

  it('rejects oversized requests and batches before importing and recovers on retry', async () => {
    const request = await signedRequest();
    request.headers.set('Content-Length', String(256 * 1024 + 1));
    expect((await worker.fetch(request, configured)).status).toBe(413);
    swipes = Array.from({ length: 513 }, (_, i) => ({ id: `large-${i}`, time: new Date().toISOString(), controller: 'door', fob: 7, allowed: true }));
    await expect(pushSwipes()).rejects.toMatchObject({ status: 400 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(0);
    swipes = [];
    await pushSwipes();
  });

  it('provisions a key on upgrade with no membership changes and preserves it through diffs and full sync', async () => {
    const m = await member();
    const revision = (await env.DB.prepare('SELECT revision FROM edge_changes').first()).revision;
    goal = { version: 10, fobs: [7] };
    await runInDurableObject(stub(), async (_instance, ctx) => ctx.storage.put('syncedRevision', revision));
    await edgeCall(configured, 'changes');
    const secret = goal.event_signing_key;
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(writes[0]).toMatchObject({ method: 'PUT', version: 11, fobs: [7] });
    await env.DB.prepare('UPDATE members SET fob_id = 8 WHERE member_id = ?').bind(m.member_id).run();
    await edgeCall(configured, 'changes');
    expect(writes[1].method).toBe('PATCH');
    expect(goal.event_signing_key).toBe(secret);
    await edgeCall(configured, 'full');
    expect(goal.event_signing_key).toBe(secret);
  });

  it('authenticates exact bodies and rejects missing, wrong, stale, and future signatures', async () => {
    swipes = [{ id: 'authenticated', time: new Date().toISOString(), controller: 'door', fob: 7, allowed: true }];
    expect((await worker.fetch(new Request(`${env.SITE_URL}/webhooks/edge/swipes`, { method: 'POST', body: '[]' }), configured)).status).toBe(401);
    for (const options of [{ key: 'ff'.repeat(32) }, { timestamp: Math.floor(Date.now() / 1000) - 301 }, { timestamp: Math.floor(Date.now() / 1000) + 301 }]) {
      expect((await worker.fetch(await signedRequest(undefined, options), configured)).status).toBe(401);
    }
    const signed = await signedRequest();
    expect((await worker.fetch(new Request(signed, { body: '[]' }), configured)).status).toBe(401);
    const withBOM = await signedRequest();
    expect((await worker.fetch(new Request(withBOM, { body: '\uFEFF' + JSON.stringify(swipes) }), configured)).status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(0);
    await pushSwipes();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(1);
  });

  it('accepts the shared Go HMAC test vector and ingests while goal delivery is pending', async () => {
    await edgeCall(configured, 'changes');
    await runInDurableObject(stub(), async (instance, ctx) => {
      await ctx.storage.put('eventSigningKey', '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      let release;
      instance.tail = new Promise(resolve => { release = resolve; });
      vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
      try {
        const response = await instance.fetch(new Request(`${env.SITE_URL}/webhooks/edge/swipes`, { method: 'POST', body: '[]', headers: {
          'X-Edge-Timestamp': '1800000000', 'X-Edge-Signature': 'a0f5b2711c0fa2ef9d3b0f61e05be1205bba0eaf03e10e7d98cdbc0840355842',
        } }));
        expect(response.status).toBe(204);
      } finally { release(); vi.restoreAllMocks(); }
    });
  });
});

describe('Edge authentication', () => {
  const config = { ...env, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
  const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const parse = value => JSON.parse(new TextDecoder().decode(decode(value)));
  afterEach(() => vi.restoreAllMocks());

  it('matches the Go verifier interoperability fixture', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    expect(await edgeToken(config)).toBe('eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsifQ.eyJpc3MiOiJodHRwczovL3RoZWxhYi5leGFtcGxlIiwiYXVkIjoiaHR0cHM6Ly9lZGdlLmV4YW1wbGUiLCJzdWIiOiJlZGdlLXN5bmMiLCJzY29wZSI6ImVkZ2U6YXBpIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.c9kUt-WlqySz-RDa62Q4wgwoV9a0XMGole4SYlWp1xJEKBhSKTsERxcoIUMih0TiU2Wa1UodgU7AM8qfz5zjAw');
  });

  it('publishes only public JWKS fields and signs matching short-lived API tokens', async () => {
    const response = await worker.fetch(new Request(`${env.SITE_URL}/.well-known/edge-jwks.json`), config);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    const { keys } = await response.json();
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
    expect(keys[0]).toMatchObject({ alg: 'EdDSA', kty: 'OKP', crv: 'Ed25519', use: 'sig', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' });
    const [header, payload, signature] = (await edgeToken(config)).split('.');
    expect(parse(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: keys[0].kid });
    const claims = parse(payload);
    expect(claims).toEqual({ iss: env.SITE_URL, aud: config.EDGE_URL, sub: 'edge-sync', scope: 'edge:api', iat: expect.any(Number), exp: expect.any(Number) });
    expect(claims.exp - claims.iat).toBe(60);
    const key = await crypto.subtle.importKey('jwk', keys[0], 'Ed25519', false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', key, decode(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    expect((await worker.fetch(new Request(`${env.SITE_URL}/.well-known/edge-jwks.json`, { method: 'POST' }), config)).status).toBe(405);
  });

  it('supports overlapping rotation keys with stable thumbprints and strips private fields', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const nextSecret = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
    const before = await (await edgeJWKS(null, config)).json();
    const staged = await (await edgeJWKS(null, { ...config, EDGE_JWT_PUBLIC_KEYS: JSON.stringify([jwk, jwk]) })).json();
    expect(staged.keys).toHaveLength(2);
    expect(staged.keys.some(k => 'd' in k)).toBe(false);
    const rotated = { ...config, EDGE_JWT_PRIVATE_KEY: nextSecret, EDGE_JWT_PUBLIC_KEYS: JSON.stringify(before.keys) };
    const after = await (await edgeJWKS(null, rotated)).json();
    expect(after.keys.map(k => k.kid).sort()).toEqual(staged.keys.map(k => k.kid).sort());
    expect(parse((await edgeToken(rotated)).split('.')[0]).kid).toBe(staged.keys[1].kid);
  });

  it('fails closed on missing/invalid signing keys and malformed extra keys', async () => {
    for (const secret of ['', 'invalid']) {
      await expect(edgeToken({ ...config, EDGE_JWT_PRIVATE_KEY: secret })).rejects.toThrow('signing key');
      expect((await worker.fetch(new Request(`${env.SITE_URL}/.well-known/edge-jwks.json`), { ...config, EDGE_JWT_PRIVATE_KEY: secret })).status).toBe(503);
    }
    for (const keys of ['null', '{}', '[{"kty":"RSA"}]']) {
      await expect(edgeJWKS(null, { ...config, EDGE_JWT_PUBLIC_KEYS: keys })).rejects.toThrow('public keys');
    }
  });

  it('sends signed bearer tokens without Access credentials and does not follow redirects', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://other.example' } }));
    const response = await EdgeSync.prototype.request.call({ env: config }, '/api/swipes');
    expect(response.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://edge.example/api/swipes');
    expect(init.redirect).toBe('manual');
    expect(Object.keys(init.headers).sort()).toEqual(['Authorization', 'Content-Type']);
    expect(parse(init.headers.Authorization.slice(7).split('.')[1]).scope).toBe('edge:api');
    await expect(EdgeSync.prototype.request.call({ env: { ...config, EDGE_URL: 'http://edge.example' } }, '/api/swipes')).rejects.toThrow('configuration');
  });
});

describe('Fob enrollment', () => {
  let config, fetchSpy, edgeClaims;
  const api = (path, options = {}, bindings = config) => worker.fetch(new Request(`${bindings.SITE_URL}${path}`, options), bindings);
  async function claim(fob = 123) {
    const token = randomToken(), expires = now() + 300;
    edgeClaims.set(token, { id: token, fob_id: fob, created: now(), expires });
    return { token, expires, url: `${config.SITE_URL}/keyfob/bind?token=${token}` };
  }
  async function member(id = '333333333333333333', fob = null) {
    const m = await env.DB.prepare('INSERT INTO members(discord_user_id, discord_username, fob_id) VALUES (?, ?, ?) RETURNING *').bind(id, 'Maker', fob).first();
    const token = await memberToken(config, m);
    return { ...m, token, cookie: `thelab_member=${token}` };
  }
  const readMember = m => env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(m.member_id).first();
  async function bind(c, m, headers = {}, csrf) {
    return api(`/keyfob/bind?token=${c.token}`, { method: 'POST', headers: { Cookie: m.cookie, Origin: config.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ csrf: csrf ?? await hash(`fob-csrf:${m.token}:${c.token}`) }) });
  }

  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    config = { ...env, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
    edgeClaims = new Map();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(new URL(url).origin).toBe(config.EDGE_URL);
      expect(new URL(url).pathname).toBe('/api/kiosk/claim');
      expect(init.redirect).toBe('manual');
      expect(init.headers.Authorization).toMatch(/^Bearer /);
      new Request(url, init);
      const claim = edgeClaims.get(new URL(url).searchParams.get('token'));
      return claim ? Response.json(claim) : new Response(null, { status: 410 });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('redirects the kiosk to the LAN hostname without network authentication', async () => {
    const response = await api('/kiosk', {}, { ...config, EDGE_URL: '' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('http://edge.thelab.ms/kiosk');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates an opaque edge claim once and preserves it through Discord login', async () => {
    const c = await claim(4294967295);
    expect(await fobClaim(config, c.token)).toMatchObject({ id: c.token, fob_id: 4294967295, expires: c.expires, claimed_by: null });
    await fobClaim(config, c.token);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    for (const audience of ['member', 'oauth', 'admin']) expect(await verifyToken(config, c.token, audience)).toBeNull();
    expect(loginDestination(`/keyfob/bind?token=${c.token}`, 'member')).toBe(`/keyfob/bind?token=${c.token}`);
    expect(loginDestination(`/keyfob/bind?token=${c.token}&next=https://evil.example`, 'member')).toBe('/payment/resume');
  });

  it.each([301, 302, 303, 307, 308, 401, 500])('rejects unsuccessful edge lookups (%s) without following redirects', async status => {
    const c = await claim();
    fetchSpy.mockImplementation(async (_url, init) => {
      expect(init.redirect).toBe('manual');
      return new Response(null, { status, headers: { Location: 'https://unexpected.example/claim' } });
    });
    expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(503);
    expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
  });

  it('rejects unavailable or malformed edge claims', async () => {
    const c = await claim();
    for (const invalid of [{ id: randomToken() }, { fob_id: 0 }, { fob_id: '123' }, { expires: c.expires + 1 }, { created: now() + 10 }]) {
      fetchSpy.mockResolvedValueOnce(Response.json({ ...edgeClaims.get(c.token), ...invalid }));
      expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(503);
    }
    fetchSpy.mockResolvedValueOnce(Response.json({ ...edgeClaims.get(c.token), created: now() - 301, expires: now() - 1 }));
    expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(410);
    fetchSpy.mockRejectedValue(new Error('Edge unavailable'));
    expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(503);
    expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
  });

  it('preserves the claim through browser-bound Discord OAuth and never links on GET', async () => {
    const c = await claim(), m = await member(), path = `/keyfob/bind?token=${c.token}`;
    const start = await api(path);
    expect(start.status).toBe(303);
    const target = new URL(start.headers.get('Location')), state = target.searchParams.get('state');
    const browserCookie = start.headers.get('Set-Cookie').split(';')[0];
    expect(await verifyOAuthState(config, state, browserCookie.split('=')[1])).toMatchObject({ purpose: 'member', return_to: path });
    fetchSpy.mockImplementation(async url => {
      if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'opaque', token_type: 'Bearer' });
      if (String(url).endsWith('/users/@me')) return Response.json({ id: m.discord_user_id, username: 'Maker', email: 'maker@example.com', verified: true });
      if (String(url).includes('/members/')) return Response.json({ roles: [] });
      throw new Error('Unexpected fetch');
    });
    const callback = await api(`/login/discord/callback?code=test&state=${state}`, { headers: { Cookie: browserCookie } });
    expect(callback.status).toBe(303);
    expect(callback.headers.get('Location')).toBe(c.url);
    const response = await api(path, { headers: { Cookie: m.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('Link fob');
    expect((await readMember(m)).fob_id).toBeNull();
  });

  it('rejects missing auth, cross-origin and wrong-CSRF posts, tampering and wrong audiences', async () => {
    const c = await claim(), m = await member();
    expect((await bind(c, m, { Cookie: '' })).status).toBe(401);
    expect((await bind(c, m, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await bind(c, m, {}, 'wrong')).status).toBe(403);
    for (const token of [`${c.token}x`, m.token, await issueToken(config, randomToken(), 'oauth'), randomToken()]) {
      expect((await bind({ token }, m)).status).toBe(410);
    }
    expect((await readMember(m)).fob_id).toBeNull();
  });

  it('replaces an existing fob from cellular, records history and blocks replay', async () => {
    const c = await claim(), m = await member(undefined, 99);
    expect(await (await api(`/keyfob/bind?token=${c.token}`, { headers: { Cookie: m.cookie } })).text()).toContain('replaces fob <strong>99');
    const response = await bind(c, m);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Fob linked');
    expect(await readMember(m)).toMatchObject({ fob_id: 123, metadata_version: m.metadata_version + 1 });
    const event = await env.DB.prepare("SELECT details FROM member_events WHERE member_id = ? AND event_type = 'FobChanged'").bind(m.member_id).first();
    expect(JSON.parse(event.details)).toEqual({ from: 99, to: 123 });
    expect(await env.DB.prepare('SELECT ended FROM fob_assignments WHERE fob = 99').first()).toMatchObject({ ended: expect.any(Number) });
    expect((await bind(c, m)).status).toBe(409);
  });

  it('rejects ownership conflicts without consuming the claim', async () => {
    const c = await claim(), owner = await member(undefined, 123), other = await member('555555555555555555', 456);
    expect((await bind(c, other)).status).toBe(409);
    expect((await readMember(other)).fob_id).toBe(456);
    expect((await env.DB.prepare('SELECT claimed_by FROM fob_claims').first()).claimed_by).toBeNull();
    expect((await bind(c, owner)).status).toBe(200);
  });

  it('allows exactly one winner for concurrent redemption and concurrent same-fob claims', async () => {
    const a = await member(), b = await member('555555555555555555'), c = await claim();
    expect((await Promise.all([bind(c, a), bind(c, b)])).map(r => r.status).sort()).toEqual([200, 409]);
    const c1 = await claim(789), c2 = await claim(789);
    expect((await Promise.all([bind(c1, a), bind(c2, b)])).map(r => r.status).sort()).toEqual([200, 409]);
    const rows = await env.DB.prepare('SELECT claimed_by FROM fob_claims WHERE fob_id = 789').all();
    expect(rows.results.filter(r => r.claimed_by !== null)).toHaveLength(1);
  });

  it('rechecks identity in the lock and rejects expired claims', async () => {
    const c = await claim(), m = await member();
    await fobClaim(config, c.token);
    await env.DB.prepare('UPDATE members SET auth_version = auth_version + 1 WHERE member_id = ?').bind(m.member_id).run();
    await expect(coordinated(config, m.member_id, 'linkFob', { token: c.token, discord_user_id: m.discord_user_id, auth_version: m.auth_version })).rejects.toMatchObject({ status: 401 });
    vi.spyOn(Date, 'now').mockReturnValue((c.expires + 1) * 1000);
    expect((await api(`/keyfob/bind?token=${c.token}`, { headers: { Cookie: m.cookie } })).status).toBe(410);
    await cleanupFobClaims(config);
    expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
  });

  it('synchronizes replacement immediately and retains the commit when edge delivery fails', async () => {
    const m = await member(undefined, 99);
    await env.DB.prepare('UPDATE members SET non_billable = 1 WHERE member_id = ?').bind(m.member_id).run();
    const edgeConfig = { ...config, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
    await runInDurableObject(env.MEMBERS.get(env.MEMBERS.idFromName(m.member_id)), instance => { instance.env = { ...instance.env, ...edgeConfig }; });
    await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), instance => { instance.env = { ...instance.env, ...edgeConfig }; });
    const c = await claim(), next = await claim(456), writes = [];
    await fobClaim(config, c.token);
    await fobClaim(config, next.token);
    fetchSpy.mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://edge.example/api/goal');
      if (init.method === 'GET') return new Response(null, { status: 503 });
      writes.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    });
    expect((await bind(c, m)).status).toBe(200);
    expect(writes).toEqual([{ version: expect.any(Number), fobs: [123], event_signing_key: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), async (_instance, ctx) => { expect(await ctx.storage.getAlarm()).toBeNull(); });
    fetchSpy.mockRejectedValue(new Error('Edge offline'));
    expect((await bind(next, m)).status).toBe(200);
    expect((await readMember(m)).fob_id).toBe(456);
    await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), async (_instance, ctx) => { expect(await ctx.storage.getAlarm()).not.toBeNull(); });
  });
});

describe('Printer access', () => {
  it('redirects anonymous visitors directly to the public machines page', async () => {
    for (const suffix of ['', '?state=obsolete&return_to=https://evil.example']) {
      const response = await worker.fetch(new Request(`${env.SITE_URL}/machines${suffix}`), { ...env, PRINTER_EDGE_URL: 'https://edge.example' });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('https://edge.example/machines');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('rejects unsafe or incomplete dashboard configuration', async () => {
    for (const origin of ['', 'http://edge.example', 'https://edge.example/path', 'https://user:password@edge.example']) {
      expect((await worker.fetch(new Request(`${env.SITE_URL}/machines`), { ...env, PRINTER_EDGE_URL: origin })).status).toBe(503);
    }
  });
});
