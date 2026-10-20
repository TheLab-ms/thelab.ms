// Member sessions stay on the Worker. Short-lived, read-only tokens authorize
// direct edge fetches; neither tokens nor image bytes pass through image URLs.
/** @typedef {{ edge: string, token: string, expires: number, renew: number }} Access */
/** @typedef {{ controller: AbortController, timeout?: ReturnType<typeof setTimeout> }} Operation */
/** @typedef {{ Name: string, Status: string, Remaining: string, Updated: string, Image: string, Unavailable: boolean }} Card */

const statusLine = /** @type {HTMLElement} */ (document.getElementById('refresh-status'));
const printers = /** @type {HTMLElement} */ (document.getElementById('printers'));
let stopped = false, suspended = false;
/** @type {Operation | undefined} */
let current;
/** @type {ReturnType<typeof setInterval> | undefined} */
let interval;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let expiryTimer;
/** @type {Access | undefined} */
let access;
/** @type {Set<string>} */
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
  statusLine.textContent = 'Printer access ended. Sign in again or check your membership eligibility.';
  /** @type {HTMLElement} */ (document.getElementById('access-help')).hidden = false;
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
  statusLine.textContent = 'Checking printer access…';
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

/**
 * @param {unknown} data
 * @param {number} started
 * @returns {Access}
 */
function credentials(data, started) {
  if (typeof data !== 'object' || data === null || !('token' in data) || !('edge' in data)
    || typeof data.token !== 'string' || data.token.length > 4096 || typeof data.edge !== 'string'
    || new URL(data.edge).protocol !== 'https:' || new URL(data.edge).origin !== data.edge) throw new Error('Invalid credentials');
  // The edge verifies the signature. Decode only to bound local reuse/display.
  /** @type {Partial<Record<string, unknown>>} */
  const claims = JSON.parse(atob((data.token.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/')));
  if (claims.scope !== 'printers:read' || claims.aud !== data.edge
    || typeof claims.iat !== 'number' || !Number.isInteger(claims.iat) || typeof claims.exp !== 'number' || !Number.isInteger(claims.exp)
    || claims.exp <= claims.iat || claims.exp - claims.iat > 60) throw new Error('Invalid token lifetime');
  const expires = Math.min(claims.exp * 1000, started + 60000);
  if (expires <= Date.now()) throw new Error('Expired credentials');
  return { edge: data.edge, token: data.token, expires, renew: expires - 15000 };
}

/**
 * @param {unknown} card
 * @returns {card is Card}
 */
function isCard(card) {
  if (typeof card !== 'object' || card === null) return false;
  const fields = /** @type {Partial<Record<string, unknown>>} */ (card);
  return ['Name', 'Status', 'Remaining', 'Updated', 'Image'].every(key => typeof fields[key] === 'string') && typeof fields.Unavailable === 'boolean';
}

/**
 * @param {unknown} cards
 * @param {string} edge
 */
function validateCards(cards, edge) {
  if (!Array.isArray(cards) || cards.length > 32 || !cards.every(isCard) || cards.some(card =>
    !/^\/machines\/images\/[^/?#\\\s]+\.jpg$/.test(card.Image)
    || new URL(card.Image, edge).origin !== edge
    || new URL(card.Image, edge).pathname !== card.Image)
    || new Set(cards.map(card => card.Image)).size !== cards.length) throw new Error('Invalid printer status');
  return cards;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [text]
 * @param {string} [className]
 * @returns {HTMLElementTagNameMap[K]}
 */
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function refresh() {
  if (current || stopped || suspended || document.hidden) return;
  /** @type {Operation} */
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
    if (!usable() || !access) return;
    const { edge, token } = access;
    /** @type {RequestInit} */
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
    /** @type {{ image: HTMLImageElement, path: string }[]} */
    const images = [];
    for (const card of cards) {
      const article = element('article', undefined, 'card');
      const details = element('div', undefined, 'details');
      const times = element('dl');
      times.append(element('dt', 'Remaining print time'), element('dd', card.Remaining));
      details.append(element('h2', card.Name), element('p', card.Status, `status${card.Unavailable ? ' unavailable' : ''}`), times);
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
    statusLine.textContent = '';
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
      statusLine.textContent = 'Connection lost — printer status unavailable. Retrying every 5 seconds.';
    }
  } finally {
    clearTimeout(operation.timeout);
    if (current === operation) current = undefined;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pause();
    if (!stopped) statusLine.textContent = 'Refresh paused while this page is hidden.';
  } else resume();
});
window.addEventListener('pagehide', () => { suspended = true; access = undefined; pause(); });
window.addEventListener('pageshow', () => { suspended = false; resume(); });
resume();
