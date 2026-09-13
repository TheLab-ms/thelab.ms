async function completeLogin() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', '/printers/callback');
  try {
    if (!token) throw new Error('Missing sign-in token.');
    const response = await fetch('/printers/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) throw new Error('Sign-in expired or was not valid for this browser.');
    location.replace('/printers');
  } catch {
    document.querySelector('#login-status').textContent = 'Unable to complete sign-in. Please use Restart sign-in below.';
  }
}

function watchImages() {
  for (const image of document.querySelectorAll('[data-camera]')) {
    const loaded = () => { image.hidden = !image.naturalWidth; };
    image.addEventListener('load', loaded);
    image.addEventListener('error', () => { image.hidden = true; });
    if (image.complete) loaded();
  }
}

function startDashboard() {
  const expires = Number(document.querySelector('#dashboard').dataset.expires) * 1000;
  const status = document.querySelector('#refresh-status');
  let updating = false;
  watchImages();
  const renew = () => location.replace('/printers/login');
  // A top-level round-trip also works when third-party cookies are blocked.
  setTimeout(renew, Math.max(0, expires - Date.now() - 30000));
  const refresh = async () => {
    if (Date.now() >= expires - 30000) { renew(); return; }
    if (updating) return;
    updating = true;
    try {
      const response = await fetch('/printers/content', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if (response.status === 401) { renew(); return; }
      if (!response.ok) throw new Error('Status unavailable');
      const html = await response.text();
      // Only same-origin, server-rendered, HTML-escaped printer cards are inserted.
      document.querySelector('#printers').innerHTML = html;
      watchImages();
      status.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · Refreshing every 5 seconds.';
    } catch {
      status.textContent = 'Connection lost — displayed status may be out of date. Retrying every 5 seconds.';
      // Do not present an old still as a current camera image during an outage.
      for (const image of document.querySelectorAll('[data-camera]')) image.hidden = true;
    } finally { updating = false; }
  };
  setInterval(refresh, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

if (location.pathname === '/printers/callback') completeLogin();
else if (document.querySelector('#dashboard')) startDashboard();
