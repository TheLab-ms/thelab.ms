// LAN-only key-fob enrollment.
/** @typedef {{ qr: string, expires: number }} Claim */

function startKiosk() {
  const kiosk = /** @type {HTMLElement} */ (document.getElementById('kiosk'));
  const status = /** @type {HTMLElement} */ (document.getElementById('status'));
  const panel = /** @type {HTMLElement} */ (document.getElementById('claim'));
  const qr = /** @type {HTMLImageElement} */ (document.getElementById('qr'));
  let buffer = '';
  let generation = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let expiryTimer;
  /** @type {AbortController | undefined} */
  let controller;

  function reset(message = 'Tap your fob', error = false) {
    generation++;
    controller?.abort();
    clearTimeout(idleTimer);
    clearTimeout(expiryTimer);
    buffer = '';
    panel.hidden = true;
    kiosk.dataset.state = error ? 'error' : 'ready';
    qr.removeAttribute('src');
    status.setAttribute('role', error ? 'alert' : 'status');
    status.textContent = message;
  }
  /**
   * @param {string} url
   * @param {RequestInit} options
   * @param {AbortSignal} signal
   * @returns {Promise<Claim>}
   */
  async function api(url, options, signal) {
    let response, result;
    try {
      response = await fetch(url, { ...options, signal, cache: 'no-store' });
      result = await response.json();
    } catch {
      throw new Error('Unavailable. Scan again.');
    }
    if (!response.ok) throw Object.assign(new Error(result.error || 'Failed. Scan again.'), { status: response.status });
    return result;
  }
  async function submit() {
    const value = buffer;
    if (!value) return;
    reset('Reading…');
    kiosk.dataset.state = 'reading';
    const current = generation;
    controller = new AbortController();
    try {
      const fob = Number(value);
      if (!/^\d{1,20}$/.test(value) || !Number.isInteger(fob) || fob < 1 || fob > 4294967295) throw new Error('Fob not recognized. Scan again.');
      const claim = await api('/kiosk/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fob_id: fob }) }, controller.signal);
      if (current !== generation) return;
      qr.src = claim.qr;
      panel.hidden = false;
      kiosk.dataset.state = 'claim';
      expiryTimer = setTimeout(() => reset('Code expired. Scan again.'), Math.max(0, claim.expires * 1000 - Date.now()));
    } catch (error) {
      if (current === generation) reset(error instanceof Error ? error.message : 'Failed. Scan again.', true);
    }
  }
  /** @type {HTMLElement} */ (document.getElementById('close')).addEventListener('click', () => reset());
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    // Capture the HID reader globally, even after someone clicks a kiosk control.
    // Enter/Tab suffixes are part of the burst; only silence submits the scan.
    if (event.key.length === 1) {
      event.preventDefault();
      if (!buffer) { reset('Reading…'); kiosk.dataset.state = 'reading'; }
      // Keep an overlong scan invalid without letting the buffer grow indefinitely.
      if (buffer.length < 21) buffer += event.key;
    } else if (!buffer) {
      if (event.key === 'Escape' && !panel.hidden) reset();
      return;
    } else if (event.key === 'Enter' || event.key === 'Tab') event.preventDefault();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(submit, 300);
  });
  window.addEventListener('blur', () => { if (buffer) reset('Scan interrupted. Try again.'); });
  window.addEventListener('pagehide', () => reset());
}

if (document.getElementById('kiosk')) startKiosk();
