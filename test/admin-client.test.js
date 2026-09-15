import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

it.each([false, true])('requires browser confirmation before deletion (confirmed: %s)', async confirmed => {
  vi.resetModules();
  const form = Object.assign(new EventTarget(), { dataset: { confirm: 'Delete Maker? This cannot be undone.' } });
  const button = { disabled: true };
  const confirm = vi.fn(() => confirmed);
  vi.stubGlobal('document', { getElementById: () => form, querySelector: () => button });
  vi.stubGlobal('window', { confirm });
  await import('../static/admin.js');
  expect(button.disabled).toBe(false);
  const event = new Event('submit', { cancelable: true });
  form.dispatchEvent(event);
  expect(confirm).toHaveBeenCalledWith(form.dataset.confirm);
  expect(event.defaultPrevented).toBe(!confirmed);
});
