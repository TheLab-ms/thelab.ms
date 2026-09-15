const kiosk = document.getElementById('kiosk');
const standby = document.getElementById('standby');
const status = document.getElementById('status');
const panel = document.getElementById('claim');
let buffer = '';
let generation = 0, idleTimer, pollTimer, expiryTimer, controller;

function notice(message, error = false) {
  status.setAttribute('role', error ? 'alert' : 'status');
  status.textContent = message;
}
function reset(message = 'Ready when you are. Just tap your fob.', error = false) {
  generation++;
  controller?.abort();
  clearTimeout(idleTimer);
  clearTimeout(pollTimer);
  clearTimeout(expiryTimer);
  buffer = '';
  panel.hidden = true;
  standby.hidden = false;
  kiosk.dataset.state = error ? 'error' : 'ready';
  document.getElementById('qr').removeAttribute('src');
  notice(message, error);
}
async function api(url, options = {}) {
  let response, result;
  try {
    response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    result = await response.json();
  } catch {
    throw new Error('Fob enrollment is temporarily unavailable. Please scan again.');
  }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Enrollment failed. Try again.'), { status: response.status });
  return result;
}
async function submit() {
  const value = buffer;
  if (!value) return;
  reset('Reading fob…');
  kiosk.dataset.state = 'reading';
  const current = generation;
  controller = new AbortController();
  try {
    const fob = Number(value);
    if (!/^\d{1,20}$/.test(value) || !Number.isInteger(fob) || fob < 1 || fob > 4294967295) throw new Error('Fob not recognized. Scan again.');
    const claim = await api('/kiosk/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fob_id: fob }) });
    if (current !== generation) return;
    document.getElementById('qr').src = claim.qr;
    document.getElementById('expiry').textContent = `Expires at ${new Date(claim.expires * 1000).toLocaleTimeString()}.`;
    panel.hidden = false;
    standby.hidden = true;
    kiosk.dataset.state = 'claim';
    notice('Scan the QR code with your phone. Sign in through Discord, then tap Link fob.');
    expiryTimer = setTimeout(() => reset('Code expired. Scan your fob again.'), Math.max(0, claim.expires * 1000 - Date.now()));
    const poll = async () => {
      try {
        const result = await api(`/kiosk/claims?token=${encodeURIComponent(claim.token)}`);
        if (current !== generation) return;
        if (result.claimed) { reset('You’re all set! Fob linked. Ready for the next scan.'); return; }
        notice('Scan the QR code with your phone. Sign in through Discord, then tap Link fob.');
      } catch (error) {
        if (current !== generation) return;
        if ([403, 404, 410].includes(error.status)) { reset(error.message, true); return; }
        notice('Could not check completion. Retrying…', true);
      }
      pollTimer = setTimeout(poll, 2000);
    };
    pollTimer = setTimeout(poll, 1500);
  } catch (error) {
    if (current === generation) reset(error.message, true);
  }
}
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  // Capture the HID reader globally, even after someone clicks a kiosk control.
  // Enter/Tab suffixes are part of the burst; only silence submits the scan.
  if (event.key.length === 1) {
    event.preventDefault();
    if (!buffer) { reset('Receiving fob…'); kiosk.dataset.state = 'reading'; }
    // Keep an overlong scan invalid without letting the buffer grow indefinitely.
    if (buffer.length < 21) buffer += event.key;
  } else if (!buffer) return;
  else if (event.key === 'Enter' || event.key === 'Tab') event.preventDefault();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(submit, 300);
});
document.getElementById('done').addEventListener('click', () => reset());
window.addEventListener('blur', () => { if (buffer) reset('Scan interrupted. Tap your fob again.'); });
window.addEventListener('pagehide', () => reset());
