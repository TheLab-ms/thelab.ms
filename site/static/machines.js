// Member sessions stay on the Worker. Short-lived, read-only tokens authorize
// direct edge fetches; neither tokens nor image bytes pass through image URLs.
const status = document.getElementById('refresh-status');
const printers = document.getElementById('printers');
let updating = false, stopped = false, controller;
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
  controller?.abort();
  clearImages();
  printers.replaceChildren();
  status.textContent = 'Printer access ended. Sign in again or check your membership eligibility.';
  document.getElementById('access-help').hidden = false;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function refresh() {
  if (updating || stopped) return;
  updating = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/machines/data', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if ([401, 403].includes(response.status)) { denyAccess(); return; }
    if (!response.ok) throw new Error('Status unavailable');
    const { cards, edge, token } = await response.json();
    if (stopped) return;
    clearImages();
    printers.replaceChildren();
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
      image.addEventListener('load', () => { if (!stopped) image.hidden = false; });
      image.addEventListener('error', () => { image.hidden = true; });
      camera.append(element('p', 'Camera unavailable — retrying automatically.'), image);
      article.append(details, camera);
      printers.append(article);
      images.push({ image, path: card.Image });
    }
    if (!cards.length) printers.append(element('p', 'No printers are configured yet.'));
    status.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · Refreshing every 5 seconds.';
    await Promise.all(images.map(async ({ image, path }) => {
      try {
        const response = await fetch(new URL(path, edge), {
          headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', mode: 'cors',
          cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        if ([401, 403].includes(response.status)) { denyAccess(); return; }
        if (!response.ok || response.headers.get('Content-Type') !== 'image/jpeg') throw new Error('Camera unavailable');
        const blob = await response.blob();
        if (stopped || controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        blobs.add(url);
        image.src = url;
      } catch { image.hidden = true; }
    }));
  } catch {
    if (!stopped) {
      clearImages();
      status.textContent = 'Connection lost — displayed status may be out of date. Retrying every 5 seconds.';
    }
  } finally {
    clearTimeout(timeout);
    updating = false;
  }
}

setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('pagehide', () => { stopped = true; controller?.abort(); clearImages(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
refresh();
