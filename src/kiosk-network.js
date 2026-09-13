import { boundedText, HttpError, origin } from './http.js';

let cached;

// URL parsing canonicalizes equivalent IPv6 spellings without accepting ports,
// forwarded address lists, or hostnames as client IPs.
function ip(value) {
  if (typeof value !== 'string') return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const parts = value.split('.');
    return parts.every(n => Number(n) <= 255 && String(Number(n)) === n) ? value : null;
  }
  if (!/^[a-fA-F0-9:]+$/.test(value) || !value.includes(':')) return null;
  try { return new URL(`http://[${value}]/`).hostname; } catch { return null; }
}

export async function requireKioskNetwork(request, env) {
  const site = new URL(origin(env));
  if (env.KIOSK_SKIP_IP_CHECK === 'true' && ['localhost', '127.0.0.1'].includes(site.hostname)) return;
  const client = ip(request.headers.get('CF-Connecting-IP'));
  if (!client) throw new HttpError(403, 'Fob enrollment is only available at the makerspace kiosk.');
  const hostname = env.KIOSK_HOSTNAME;
  if (typeof hostname !== 'string' || hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
    throw new HttpError(503, 'Fob enrollment is temporarily unavailable. Please ask a member for help.');
  }
  if (!cached || cached.hostname !== hostname || cached.until <= Date.now()) {
    try {
      const started = Date.now();
      const answers = await Promise.all([1, 28].map(async type => {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
          headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('DNS lookup failed');
        const result = JSON.parse(await boundedText(response, 32768));
        if (result.Status !== 0 || result.TC) throw new Error('DNS lookup failed');
        return result.Answer || [];
      }));
      const records = answers.flat();
      const addresses = records.filter(r => [1, 28].includes(r.type)).map(r => ip(r.data)).filter(Boolean);
      if (!addresses.length) throw new Error('No network addresses');
      // Include CNAME TTLs so an alias cannot extend an old address's lifetime.
      const ttl = Math.min(60, ...records.map(r => Number.isFinite(r.TTL) && r.TTL >= 0 ? r.TTL : 0));
      cached = { hostname, addresses, until: started + ttl * 1000 };
    } catch {
      cached = null;
      throw new HttpError(503, 'Fob enrollment is temporarily unavailable. Please try again.');
    }
  }
  if (!cached.addresses.includes(client)) throw new HttpError(403, 'Fob enrollment is only available at the makerspace kiosk.');
}
