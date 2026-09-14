function watchImages() {
  for (const image of document.querySelectorAll('[data-camera]')) {
    const loaded = () => { image.hidden = !image.naturalWidth; };
    image.addEventListener('load', loaded);
    image.addEventListener('error', () => { image.hidden = true; });
    if (image.complete) loaded();
  }
}

function startDashboard() {
  const status = document.querySelector('#refresh-status');
  let updating = false;
  watchImages();
  const refresh = async () => {
    if (updating) return;
    updating = true;
    try {
      const response = await fetch('/machines/content', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
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

if (document.querySelector('#dashboard')) startDashboard();
