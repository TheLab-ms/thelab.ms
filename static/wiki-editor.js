(() => {
  const form = document.getElementById('wiki-editor');
  if (!form) return;
  const title = form.elements.title, slug = form.elements.slug, markdown = form.elements.markdown;
  const status = document.getElementById('wiki-status'), upload = document.getElementById('wiki-image');
  const preview = document.getElementById('wiki-preview'), previewButton = document.getElementById('wiki-preview-button');
  let dirty = false, busy = false, customSlug = Boolean(slug.value);
  const notice = (message, error = false) => { status.textContent = message; status.dataset.error = String(error); };
  const setBusy = value => { busy = value; form.querySelectorAll('button').forEach(button => { button.disabled = value; }); };
  form.addEventListener('input', () => { dirty = true; });
  slug.addEventListener('input', () => { customSlug = true; });
  title.addEventListener('input', () => {
    if (!customSlug && !slug.readOnly) slug.value = title.value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '');
  });
  window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });

  async function api(path, body, binary = false) {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-Wiki-CSRF': form.dataset.csrf },
      body: binary ? body : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      document.getElementById('wiki-login-help').hidden = response.status !== 401;
      throw new Error(data.error || 'The request failed. Your draft is still in the editor.');
    }
    return data;
  }

  function insert(before, after = '', placeholder = '') {
    const start = markdown.selectionStart, end = markdown.selectionEnd;
    const text = markdown.value.slice(start, end) || placeholder;
    markdown.setRangeText(before + text + after, start, end, 'end');
    markdown.focus();
    dirty = true;
  }
  const formats = { heading: ['\n## ', '\n', 'Heading'], bold: ['**', '**', 'bold text'], italic: ['*', '*', 'italic text'], link: ['[', '](/wiki/page-address)', 'Page name'], list: ['\n- ', '\n', 'List item'], code: ['\n```\n', '\n```\n', 'code'] };
  form.querySelectorAll('[data-format]').forEach(button => button.addEventListener('click', () => insert(...formats[button.dataset.format])));

  document.getElementById('wiki-upload-button').addEventListener('click', () => upload.click());
  upload.addEventListener('change', async () => {
    const file = upload.files[0];
    if (!file || busy) return;
    if (file.size > 5 * 1024 * 1024) { notice('Images must be 5 MiB or smaller.', true); upload.value = ''; return; }
    setBusy(true); notice('Uploading image…');
    try {
      const data = await api('/wiki/images', file, true);
      const alt = file.name.replace(/\.[^.]+$/, '').replace(/[\[\]\\\r\n]/g, ' ');
      insert(`\n![${alt}](${data.url})\n`);
      notice('Image inserted. Save the page to keep it.');
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); upload.value = ''; }
  });

  previewButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); notice('Rendering preview…');
    try {
      const data = await api('/wiki/preview', { markdown: markdown.value });
      document.getElementById('wiki-preview-content').innerHTML = data.html;
      preview.hidden = false; previewButton.setAttribute('aria-expanded', 'true');
      notice('Preview updated.'); preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const sent = { title: title.value, markdown: markdown.value, revision: form.dataset.revision };
    const address = slug.value;
    setBusy(true); notice('Saving page…');
    try {
      const data = await api(`/wiki/${encodeURIComponent(address)}`, sent);
      form.dataset.revision = data.revision;
      slug.value = data.slug; slug.readOnly = true;
      // Do not discard text typed while the save was in flight.
      if (title.value === sent.title && markdown.value === sent.markdown) {
        dirty = false; setBusy(false); window.location.assign(`/wiki/${data.slug}`);
      } else notice('Saved. You have additional unsaved changes in the editor.');
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });

  document.getElementById('wiki-delete')?.addEventListener('click', async () => {
    if (busy || !window.confirm('Delete this wiki page? Images unused by other pages will be removed automatically after 24 hours.')) return;
    setBusy(true); notice('Deleting page…');
    try {
      await api(`/wiki/${encodeURIComponent(slug.value)}/delete`, { revision: form.dataset.revision });
      dirty = false; setBusy(false); window.location.assign('/wiki');
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });
})();
