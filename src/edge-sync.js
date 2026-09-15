import { DurableObject } from 'cloudflare:workers';
import { boundedBytes, boundedText, HttpError, json, randomToken } from './http.js';
import { logError } from './logging.js';
import { fobEnabledSQL } from './fob-access.js';
import { edgeToken } from './edge-auth.js';

export const edgeEnabled = env => Boolean(env.EDGE_URL);
const stub = env => env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge'));
export const swipeWebhook = (request, env) => stub(env).fetch(request);
const swipePath = '/webhooks/edge/swipes';
const encoder = new TextEncoder();
const unhex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
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

export async function edgeRequest(env, path, method = 'GET', body) {
  const { EDGE_URL: origin } = env;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid edge configuration.');
  const token = await edgeToken(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${origin}${path}`, {
      method, redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await boundedText(response, 16384);
    return { status: response.status, text };
  } finally { clearTimeout(timer); }
}

function goalValid(goal) {
  return goal && Number.isSafeInteger(goal.version) && goal.version >= 0 && Array.isArray(goal.fobs)
    && goal.fobs.length <= 512 && goal.fobs.every(validFob) && new Set(goal.fobs).size === goal.fobs.length
    && (goal.event_signing_key === undefined || /^[a-f0-9]{64}$/.test(goal.event_signing_key));
}

export class EdgeSync extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.tail = Promise.resolve(); this.swipeTail = Promise.resolve(); }

  async execute(operation, input) {
    const work = this.tail.then(async () => {
      try {
        if (!edgeEnabled(this.env)) throw new Error('Edge sync is not configured.');
        if (operation === 'arm') {
          if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 30000);
        } else if (operation === 'changes') await this.reconcile(false);
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
        return { ok: false, error: 'Edge resync failed; pending changes will retry automatically.' };
      }
    });
    this.tail = work.catch(() => {});
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
    return edgeRequest(this.env, path, method, body);
  }

  async reconcile(full) {
    const revision = (await this.env.DB.prepare('SELECT revision FROM edge_changes WHERE id = 1').first()).revision;
    if (!full && await this.ctx.storage.get('eventKeyDelivered') && revision === await this.ctx.storage.get('syncedRevision')) return;
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    let eventKey = await this.ctx.storage.get('eventSigningKey');
    if (!eventKey) {
      eventKey = randomToken();
      // Persist before sending: an ambiguous goal write must remain verifiable.
      await this.ctx.storage.put('eventSigningKey', eventKey);
    }
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
    const snapshot = full || !initialized || previous.event_signing_key !== eventKey;
    if (snapshot || add.length || remove.length) {
      await this.ctx.storage.put('version', version);
      const result = await this.request('/api/goal', snapshot ? 'PUT' : 'PATCH',
        snapshot ? { version, fobs, event_signing_key: eventKey } : { base_version: previous.version, version, add, remove });
      if (result.status !== 204) throw new Error(`Edge goal write failed (${result.status}).`);
    }
    await this.ctx.storage.put('syncedRevision', revisionRows.results[0].revision);
    await this.ctx.storage.put('eventKeyDelivered', true);
  }

  async full() {
    await this.reconcile(true);
    const pending = await this.ctx.storage.get('fullPending');
    if (pending?.date) await this.ctx.storage.put('nightlyDone', pending.date);
    await this.ctx.storage.delete('fullPending');
  }

  async fetch(request) {
    try {
      if (request.method !== 'POST' || new URL(request.url).pathname !== swipePath) throw new HttpError(404, 'Not found.');
      const timestamp = request.headers.get('X-Edge-Timestamp') || '';
      const signature = request.headers.get('X-Edge-Signature') || '';
      const secret = await this.ctx.storage.get('eventSigningKey');
      if (!edgeEnabled(this.env) || !secret || !/^\d{10}$/.test(timestamp)
        || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) {
        throw new HttpError(401, 'Invalid event signature.');
      }
      const body = await boundedBytes(request, 256 * 1024);
      const prefix = encoder.encode(`POST\n${swipePath}\n${timestamp}\n`);
      const signed = new Uint8Array(prefix.length + body.length);
      signed.set(prefix);
      signed.set(body, prefix.length);
      const key = await crypto.subtle.importKey('raw', unhex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      if (!await crypto.subtle.verify('HMAC', key, unhex(signature), signed)) {
        throw new HttpError(401, 'Invalid event signature.');
      }
      let events;
      try { events = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new HttpError(400, 'Invalid swipe batch.'); }
      // Independent of goal delivery, so a goal push never blocks its event callback.
      const work = this.swipeTail.then(() => this.importSwipes(events));
      this.swipeTail = work.catch(() => {});
      await work;
      return new Response(null, { status: 204 });
    } catch (error) {
      logError('edge.swipes.failed', error, {}, this.env);
      return json({ error: 'Swipe batch could not be accepted.' }, error instanceof HttpError ? error.status : 500);
    }
  }

  async importSwipes(events) {
    if (!Array.isArray(events) || events.length > 512) throw new HttpError(400, 'Invalid swipe batch.');
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id)
        || !validFob(event.fob) || typeof event.allowed !== 'boolean'
        || typeof event.controller !== 'string' || event.controller.length > 64
        || typeof event.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(event.time)
        || !Number.isFinite(Date.parse(event.time))) throw new HttpError(400, 'Invalid swipe event.');
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
  }
}
