// Worker entrypoint. Static assets are served directly; requests that match no
// asset reach these routes.
import { HttpError, escapeHTML as e, json, logError, origin, page } from './lib.js';
import { adminRequest } from './admin.js';
import { callback, login, logout } from './auth.js';
import { checkout, stripeWebhook } from './billing.js';
import { bindFob, edgeJWKS, edgeSyncRequest, kioskClaim, machinesData, swipeWebhook } from './edge.js';
import { signWaiver } from './waiver.js';

const routes = {
  'GET /.well-known/edge-jwks.json': edgeJWKS,
  'GET /login': login,
  'GET /login/callback': callback,
  'POST /logout': logout,
  'GET /checkout': checkout,
  'POST /waiver/sign': signWaiver,
  'GET /machines/data': machinesData,
  'GET /keyfob/bind': bindFob,
  'POST /keyfob/bind': bindFob,
  'POST /kiosk/claims': kioskClaim,
  'POST /webhooks/stripe': stripeWebhook,
  'POST /webhooks/edge/swipes': swipeWebhook,
  'POST /webhooks/edge/sync': edgeSyncRequest,
};

// Machine clients receive JSON errors; people receive an HTML page.
const jsonPaths = ['/machines/data', '/kiosk/claims', '/webhooks/'];
// Machine clients authenticate with credentials, not browser cookies.
const crossOriginPaths = ['/kiosk/claims', '/webhooks/'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Browser POSTs must come from our own pages; cookies are SameSite=Lax as well.
      if (request.method === 'POST' && !crossOriginPaths.some(p => path.startsWith(p)) && request.headers.get('Origin') !== origin(env)) {
        throw new HttpError(403, 'We couldn’t verify where this form came from. Reload the page and try again.');
      }
      const handler = routes[`${request.method} ${path}`] ?? (path === '/admin' || path.startsWith('/admin/') ? adminRequest : null);
      if (!handler) throw new HttpError(404, 'Page not found.');
      return await handler(request, env, ctx);
    } catch (error) {
      logError('request.failed', error, { method: request.method, path });
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Something went wrong. Please try again.';
      if (jsonPaths.some(p => path.startsWith(p))) return json({ error: message }, status);
      return page('Let’s try that again', `<p>${e(message)}</p><div class="membership-actions"><a class="btn btn-primary" href="/">Back to TheLab</a><a class="btn btn-outline" href="https://discord.thelab.ms">Join our Discord</a></div><p class="card-desc">Need a hand? <a href="mailto:leadership@thelab.ms">Contact leadership</a>.</p>`, { status });
    }
  },
};
