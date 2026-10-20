// Worker entrypoint. Static assets are served directly, except the gated kiosk
// page; requests that match no asset reach these routes.
import { h, Fragment } from './html.ts';
import { page } from './page.tsx';
import { HttpError, json, logError, origin, type Handler } from './lib.ts';
import { adminRequest } from './admin.tsx';
import { callback, login, logout } from './auth.ts';
import { checkout, stripeWebhook } from './billing.ts';
import { bindFob, edgeJWKS, edgeSyncRequest, kioskClaim, kioskPage, machinesData, swipeWebhook } from './edge.tsx';
import { signWaiver } from './waiver.tsx';

const routes = new Map<string, Handler>(Object.entries({
  'GET /.well-known/edge-jwks.json': edgeJWKS,
  'GET /login': login,
  'GET /login/callback': callback,
  'POST /logout': logout,
  'GET /checkout': checkout,
  'POST /waiver/sign': signWaiver,
  'GET /machines/data': machinesData,
  'GET /keyfob/bind': bindFob,
  'POST /keyfob/bind': bindFob,
  'GET /kiosk': kioskPage,
  'POST /kiosk/claims': kioskClaim,
  'POST /webhooks/stripe': stripeWebhook,
  'POST /webhooks/edge/swipes': swipeWebhook,
  'POST /webhooks/edge/sync': edgeSyncRequest,
} satisfies Record<`${'GET' | 'POST'} /${string}`, Handler>));

// Machine clients receive JSON errors; people receive an HTML page.
const jsonPaths = ['/machines/data', '/kiosk/claims', '/webhooks/'];
// Machine clients authenticate with credentials, not browser cookies.
const crossOriginPaths = ['/kiosk/claims', '/webhooks/'];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Browser POSTs must come from our own pages; cookies are SameSite=Lax as well.
      if (request.method === 'POST' && !crossOriginPaths.some(p => path.startsWith(p)) && request.headers.get('Origin') !== origin(env)) {
        throw new HttpError(403, 'We couldn’t verify where this form came from. Reload the page and try again.');
      }
      const handler = routes.get(`${request.method} ${path}`) ?? (path === '/admin' || path.startsWith('/admin/') ? adminRequest : null);
      if (!handler) throw new HttpError(404, 'Page not found.');
      return await handler(request, env, ctx);
    } catch (error) {
      logError('request.failed', error, { method: request.method, path });
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Something went wrong. Please try again.';
      if (jsonPaths.some(p => path.startsWith(p))) return json({ error: message }, status);
      return page('Let’s try that again', <>
        <p>{message}</p>
        <div class="membership-actions">
          <a class="btn btn-primary" href="/">Back to TheLab</a>
          <a class="btn btn-outline" href="https://discord.thelab.ms">Join our Discord</a>
        </div>
        <p class="card-desc">Need a hand? <a href="mailto:leadership@thelab.ms">Contact leadership</a>.</p>
      </>, { status });
    }
  },
} satisfies ExportedHandler<Env>;
