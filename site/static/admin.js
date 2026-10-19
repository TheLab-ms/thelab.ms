// Admin pages: confirm before deleting a member.
const deleteForm = document.getElementById('delete-member');
if (deleteForm) {
  deleteForm.addEventListener('submit', event => {
    if (!window.confirm(deleteForm.dataset.confirm)) event.preventDefault();
  });
  document.querySelector('button[form="delete-member"]').disabled = false;
}

// List filters apply as soon as they change. Searches cover all members, so filters are disabled while typing one.
for (const select of document.querySelectorAll('select[data-autosubmit]')) {
  select.addEventListener('change', () => select.form.requestSubmit());
}
const search = document.querySelector('input[data-search]');
if (search) {
  search.addEventListener('input', () => {
    for (const select of search.form.querySelectorAll('select[data-autosubmit]')) select.disabled = search.value.trim() !== '';
  });
}
