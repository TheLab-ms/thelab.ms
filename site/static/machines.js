// Member sessions stay on the Worker. Short-lived, read-only tokens authorize
// direct edge fetches; neither tokens nor image bytes pass through image URLs.
const status = document.getElementById('refresh-status');
const printers = document.getElementById('printers');
let stopped = false, suspended = false, current, interval, expiryTimer, access;
const blobs = new Set();

function clearImages() {
  for (const image of printers.querySelectorAll('img')) {
    image.hidden = true;
    image.removeAttribute('src');
  }
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs.clear();
}

function denyAccess() {
  stopped = true;
  access = undefined;
  pause();
  status.textContent = 'Printer access ended. Sign in again or check your membership eligibility.';
  document.getElementById('access-help').hidden = false;
}

function clearDashboard() {
  clearImages();
  printers.replaceChildren();
}

function cancelRefresh() {
  current?.controller.abort();
  clearTimeout(current?.timeout);
  current = undefined;
}

function pause() {
  clearInterval(interval);
  interval = undefined;
  clearTimeout(expiryTimer);
  cancelRefresh();
  clearDashboard();
}

function expire() {
  access = undefined;
  cancelRefresh();
  clearDashboard();
  status.textContent = 'Checking printer access…';
  refresh();
}

function resume() {
  if (document.hidden || suspended || stopped) return;
  if (interval === undefined) interval = setInterval(refresh, 5000);
  clearTimeout(expiryTimer);
  if (access && Date.now() >= access.expires) access = undefined;
  if (access) expiryTimer = setTimeout(expire, access.expires - Date.now());
  refresh();
}

function credentials(data, started) {
  if (!data || typeof data.token !== 'string' || data.token.length > 4096
    || new URL(data.edge).protocol !== 'https:' || new URL(data.edge).origin !== data.edge) throw new Error('Invalid credentials');
  // The edge verifies the signature. Decode only to bound local reuse/display.
  const claims = JSON.parse(atob(data.token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
  if (claims.scope !== 'printers:read' || claims.aud !== data.edge
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
    || claims.exp <= claims.iat || claims.exp - claims.iat > 60) throw new Error('Invalid token lifetime');
  const expires = Math.min(claims.exp * 1000, started + 60000);
  if (expires <= Date.now()) throw new Error('Expired credentials');
  return { edge: data.edge, token: data.token, expires, renew: expires - 15000 };
}

function validateCards(cards, edge) {
  if (!Array.isArray(cards) || cards.length > 32 || cards.some(card => !card
    || ['Name', 'Status', 'Remaining', 'Updated', 'Image'].some(key => typeof card[key] !== 'string')
    || typeof card.Unavailable !== 'boolean'
    || !/^\/machines\/images\/[^/?#\\\s]+\.jpg$/.test(card.Image)
    || new URL(card.Image, edge).origin !== edge
    || new URL(card.Image, edge).pathname !== card.Image)
    || new Set(cards.map(card => card.Image)).size !== cards.length) throw new Error('Invalid printer status');
  return cards;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function refresh() {
  if (current || stopped || suspended || document.hidden) return;
  const operation = { controller: new AbortController() };
  current = operation;
  const { signal } = operation.controller;
  operation.timeout = setTimeout(() => operation.controller.abort(), 10000);
  const active = () => current === operation && !stopped && !suspended && !document.hidden;
  const usable = () => active() && !signal.aborted && access && Date.now() < access.expires;
  try {
    if (!access || Date.now() >= access.renew) {
      const started = Date.now();
      const response = await fetch('/machines/data', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      });
      if (!active() || signal.aborted) return;
      if ([401, 403].includes(response.status)) { denyAccess(); return; }
      if (!response.ok) throw new Error('Access check unavailable');
      const data = await response.json();
      if (!active() || signal.aborted) return;
      access = credentials(data, started);
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(expire, access.expires - Date.now());
    }
    if (!usable()) return;
    const { edge, token } = access;
    const options = {
      headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', mode: 'cors',
      cache: 'no-store', redirect: 'error', signal,
    };
    const response = await fetch(new URL('/api/printers', edge), options);
    if (!usable()) return;
    if ([401, 403].includes(response.status)) { denyAccess(); return; }
    if (!response.ok) throw new Error('Status unavailable');
    const cards = validateCards(await response.json(), edge);
    if (!usable()) return;
    clearDashboard();
    const images = [];
    for (const card of cards) {
      const article = element('article', undefined, 'card');
      const details = element('div', undefined, 'details');
      const times = element('dl');
      times.append(element('dt', 'Remaining print time'), element('dd', card.Remaining));
      details.append(element('h2', card.Name), element('p', card.Status, `status${card.Unavailable ? ' unavailable' : ''}`), times, element('small', card.Updated));
      const camera = element('div', undefined, 'camera');
      const image = element('img');
      image.alt = `Current camera image of ${card.Name}`;
      image.hidden = true;
      image.addEventListener('load', () => {
        if (!stopped && !suspended && !document.hidden && !signal.aborted
          && access && Date.now() < access.expires && blobs.has(image.src)) image.hidden = false;
      });
      image.addEventListener('error', () => { image.hidden = true; image.removeAttribute('src'); });
      camera.append(element('p', 'Camera unavailable — retrying automatically.'), image);
      article.append(details, camera);
      printers.append(article);
      images.push({ image, path: card.Image });
    }
    if (!cards.length) printers.append(element('p', 'No printers are configured yet.'));
    status.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · Refreshing every 5 seconds.';
    await Promise.all(images.map(async ({ image, path }) => {
      try {
        const response = await fetch(new URL(path, edge), options);
        if (!usable()) return;
        if ([401, 403].includes(response.status)) { denyAccess(); return; }
        if (!response.ok || response.headers.get('Content-Type') !== 'image/jpeg') throw new Error('Camera unavailable');
        const blob = await response.blob();
        if (!usable()) return;
        const url = URL.createObjectURL(blob);
        blobs.add(url);
        image.src = url;
      } catch { image.hidden = true; }
    }));
  } catch {
    if (active()) {
      clearDashboard();
      status.textContent = 'Connection lost — printer status unavailable. Retrying every 5 seconds.';
    }
  } finally {
    clearTimeout(operation.timeout);
    if (current === operation) current = undefined;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pause();
    if (!stopped) status.textContent = 'Refresh paused while this page is hidden.';
  } else resume();
});
window.addEventListener('pagehide', () => { suspended = true; access = undefined; pause(); });
window.addEventListener('pageshow', () => { suspended = false; resume(); });
resume();
