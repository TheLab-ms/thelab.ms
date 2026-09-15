const deleteForm = document.getElementById('delete-member');
if (deleteForm) {
  deleteForm.addEventListener('submit', event => {
    if (!window.confirm(deleteForm.dataset.confirm)) event.preventDefault();
  });
  document.querySelector('button[form="delete-member"]').disabled = false;
}
