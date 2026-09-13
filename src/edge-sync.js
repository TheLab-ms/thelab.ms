import { DurableObject } from 'cloudflare:workers';
import { boundedText, HttpError } from './http.js';
import { logError } from './logging.js';
import { fobEnabledSQL } from './fob-access.js';

export const edgeEnabled = env => Boolean(env.EDGE_URL);
const stub = env => env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge'));
export async function edgeCall(env, operation, input) {
  const result = await stub(env).execute(operation, input);
  if (!result.ok) throw new HttpError(503, result.error);
  return result.value;
}
// Arm BEFORE committing access-affecting changes. A crash after D1 commits still
// leaves an alarm that discovers the transactional revision/outbox.
export async function armEdge(env) { if (edgeEnabled(env)) await edgeCall(env, 'arm'); }
export async function kickEdge(env) {
  if (!edgeEnabled(env)) return;
  try { await edgeCall(env, 'changes'); }
  catch (error) { logError('edge.deferred', error, {}, env); }
}

export function nightlyDate(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
  return parts.hour === '01' ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

const validFob = n => Number.isInteger(n) && n > 0 && n <= 4294967295;
function goalValid(goal) {
  return goal && Number.isSafeInteger(goal.version) && goal.version >= 0 && Array.isArray(goal.fobs)
    && goal.fobs.length <= 512 && goal.fobs.every(validFob) && new Set(goal.fobs).size === goal.fobs.length;
}

export class EdgeSync extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.tail = Promise.resolve(); this.swipeTail = Promise.resolve(); }

  async execute(operation, input) {
    // Swipe viewing must not wait for goal delivery/retries.
    const lane = operation === 'swipes' ? 'swipeTail' : 'tail';
    const work = this[lane].then(async () => {
      try {
        if (!edgeEnabled(this.env)) throw new Error('Edge sync is not configured.');
        if (operation === 'arm') {
          if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 30000);
        } else if (operation === 'swipes') return { ok: true, value: await this.importSwipes() };
        else if (operation === 'changes') await this.reconcile(false);
        else if (operation === 'full' || operation === 'nightly') {
          if (operation === 'nightly' && await this.ctx.storage.get('nightlyDone') === input) return { ok: true };
          await this.ctx.storage.setAlarm(Date.now() + 30000);
          const pending = await this.ctx.storage.get('fullPending');
          await this.ctx.storage.put('fullPending', { date: operation === 'nightly' ? input : pending?.date || null });
          await this.full();
        } else throw new Error('Unknown edge operation.');
        return { ok: true };
      } catch (error) {
        logError('edge.failed', error, { operation }, this.env);
        return { ok: false, error: operation === 'swipes' ? 'Could not refresh swipes from edgeproxy. Reload this page to retry.' : 'Edge resync failed; pending changes will retry automatically.' };
      }
    });
    this[lane] = work.catch(() => {});
    return work;
  }

  async alarm() {
    const work = this.tail.then(async () => {
      if (!edgeEnabled(this.env)) { await this.ctx.storage.deleteAlarm(); return; }
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      if (await this.ctx.storage.get('fullPending')) await this.full();
      await this.reconcile(false);
      // Keep watching the transactional outbox. A member write can finish after
      // its pre-commit arm call, even if the request dies before its kick call.
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async request(path, method = 'GET', body) {
    const { EDGE_URL: origin, EDGE_ACCESS_CLIENT_ID: id, EDGE_ACCESS_CLIENT_SECRET: secret } = this.env;
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || !id || !secret) throw new Error('Invalid edge configuration.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${origin}${path}`, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await boundedText(response, path === '/api/swipes' ? 32 * 1024 * 1024 : 16384);
      return { status: response.status, text };
    } finally { clearTimeout(timer); }
  }

  async reconcile(full) {
    const revision = (await this.env.DB.prepare('SELECT revision FROM edge_changes WHERE id = 1').first()).revision;
    if (!full && revision === await this.ctx.storage.get('syncedRevision')) return;
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    const response = await this.request('/api/goal');
    let previous = { version: 0, fobs: [] }, initialized = false;
    if (response.status === 200) {
      previous = JSON.parse(response.text);
      if (!goalValid(previous)) throw new Error('Invalid edge goal.');
      initialized = true;
    } else if (response.status !== 503) throw new Error(`Edge goal read failed (${response.status}).`);
    // Read revision and goal together, AFTER reading edge state. New changes during
    // delivery retain a newer revision and cannot be accidentally acknowledged.
    const [revisionRows, rows] = await this.env.DB.batch([
      this.env.DB.prepare('SELECT revision FROM edge_changes WHERE id = 1'),
      this.env.DB.prepare(`SELECT fob_id FROM members WHERE ${fobEnabledSQL} ORDER BY fob_id LIMIT 513`),
    ]);
    const fobs = rows.results.map(row => row.fob_id);
    if (fobs.length > 512) throw new Error('Authorized fob set exceeds edge capacity (512).');
    const version = Math.max(previous.version, await this.ctx.storage.get('version') || 0) + 1;
    if (!Number.isSafeInteger(version)) throw new Error('Edge version exhausted.');
    const add = fobs.filter(id => !previous.fobs.includes(id)), remove = previous.fobs.filter(id => !fobs.includes(id));
    if (full || !initialized || add.length || remove.length) {
      await this.ctx.storage.put('version', version);
      const result = await this.request('/api/goal', full || !initialized ? 'PUT' : 'PATCH',
        full || !initialized ? { version, fobs } : { base_version: previous.version, version, add, remove });
      if (result.status !== 204) throw new Error(`Edge goal write failed (${result.status}).`);
    }
    await this.ctx.storage.put('syncedRevision', revisionRows.results[0].revision);
  }

  async full() {
    // Back up swipes even when goal delivery fails, and vice versa.
    const results = await Promise.allSettled([this.execute('swipes'), this.reconcile(true)]);
    if (results[0].status === 'rejected' || !results[0].value.ok || results[1].status === 'rejected') throw new Error('Full edge sync incomplete.');
    const pending = await this.ctx.storage.get('fullPending');
    if (pending?.date) await this.ctx.storage.put('nightlyDone', pending.date);
    await this.ctx.storage.delete('fullPending');
  }

  async importSwipes() {
    const response = await this.request('/api/swipes');
    if (response.status !== 200) throw new Error(`Edge swipe read failed (${response.status}).`);
    const events = JSON.parse(response.text);
    if (!Array.isArray(events)) throw new Error('Invalid swipe history.');
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id)
        || !validFob(event.fob) || typeof event.allowed !== 'boolean'
        || typeof event.controller !== 'string' || event.controller.length > 64
        || typeof event.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(event.time)
        || !Number.isFinite(Date.parse(event.time))) throw new Error('Invalid swipe event.');
    }
    for (let i = 0; i < events.length; i += 50) {
      await this.env.DB.batch(events.slice(i, i + 50).map(event => this.env.DB.prepare(`
        INSERT INTO edge_swipes(id, time, controller, fob, allowed, member_id)
        VALUES (?, ?, ?, ?, ?, (SELECT member_id FROM fob_assignments WHERE fob = ? AND started <= ?
          AND (ended IS NULL OR ended > ?) ORDER BY started DESC, id DESC LIMIT 1)) ON CONFLICT(id) DO NOTHING`)
        .bind(event.id, event.time, event.controller, event.fob, event.allowed ? 1 : 0, event.fob,
          Date.parse(event.time) / 1000, Date.parse(event.time) / 1000)));
    }
    await this.ctx.storage.put('swipesSyncedAt', Date.now());
    return { fetched: events.length };
  }
}
