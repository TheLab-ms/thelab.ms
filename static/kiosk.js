const scanner = document.getElementById('scanner');
const status = document.getElementById('status');
const panel = document.getElementById('claim');
let generation = 0, idleTimer, pollTimer, expiryTimer, controller;

function interactive(target) {
  return target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable], [tabindex]');
}
function focus() {
  if (!interactive(document.activeElement)) scanner.focus({ preventScroll: true });
}
function notice(message, error = false) {
  status.setAttribute('role', error ? 'alert' : 'status');
  status.textContent = message;
}
function reset(message = 'Ready to scan.', error = false) {
  generation++;
  controller?.abort();
  clearTimeout(idleTimer);
  clearTimeout(pollTimer);
  clearTimeout(expiryTimer);
  scanner.value = '';
  panel.hidden = true;
  document.getElementById('qr').removeAttribute('src');
  document.getElementById('claim-link').removeAttribute('href');
  notice(message, error);
  focus();
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Enrollment failed. Try again.'), { status: response.status });
  return result;
}
async function submit() {
  const value = scanner.value;
  if (!value) return;
  reset('Reading fob…');
  const current = generation;
  controller = new AbortController();
  try {
    const fob = Number(value);
    if (!/^\d{1,20}$/.test(value) || !Number.isInteger(fob) || fob < 1 || fob > 4294967295) throw new Error('Fob not recognized. Scan again.');
    const claim = await api('/kiosk/claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fob_id: fob }) });
    if (current !== generation) return;
    document.getElementById('qr').src = claim.qr;
    document.getElementById('claim-link').href = claim.url;
    document.getElementById('expiry').textContent = `Expires at ${new Date(claim.expires * 1000).toLocaleTimeString()}.`;
    panel.hidden = false;
    notice('Scan the QR code with your phone. Sign in through Discord, then tap Link fob.');
    expiryTimer = setTimeout(() => reset('Code expired. Scan your fob again.'), Math.max(0, claim.expires * 1000 - Date.now()));
    const poll = async () => {
      try {
        const result = await api(`/kiosk/claims?token=${encodeURIComponent(claim.token)}`);
        if (current !== generation) return;
        if (result.claimed) { reset('Fob linked. Ready for the next scan.'); return; }
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
function idle() {
  clearTimeout(idleTimer);
  if (scanner.value) idleTimer = setTimeout(submit, 1000);
}
scanner.addEventListener('input', idle);
document.getElementById('scanner-form').addEventListener('submit', event => { event.preventDefault(); void submit(); });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target !== scanner && interactive(event.target)) return;
  if (event.key === 'Enter' && scanner.value) { event.preventDefault(); void submit(); }
  else if (event.key.length === 1 && event.target !== scanner) {
    event.preventDefault(); scanner.value += event.key; focus(); idle();
  }
});
document.addEventListener('focusin', event => {
  if (event.target !== scanner && interactive(event.target)) { clearTimeout(idleTimer); scanner.value = ''; }
});
document.getElementById('done').addEventListener('click', () => { reset(); scanner.focus(); });
document.addEventListener('click', focus);
window.addEventListener('focus', focus);
window.addEventListener('pagehide', () => reset());
window.addEventListener('pageshow', focus);
