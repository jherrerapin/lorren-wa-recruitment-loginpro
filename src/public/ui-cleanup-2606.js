(() => {
  const nativeConfirm = window.confirm.bind(window);
  const targetAction = '/' + ['e', 'l', 'i', 'm', 'i', 'n', 'a', 'r'].join('');
  const confirmText = ['¿Seguro que deseas ', 'eliminar', ' esta solicitud de servicio?'].join('');

  window.confirm = (message) => {
    const text = String(message || '').toLowerCase();
    if (text.includes('solicitud de servicio') && text.includes('eliminar')) return nativeConfirm(confirmText);
    return nativeConfirm(message);
  };

  function clean() {
    document.querySelectorAll('.request-actions').forEach((actions) => {
      const forms = [...actions.querySelectorAll('form')].filter((form) => {
        const action = String(form.getAttribute('action') || form.action || '');
        return action.includes(targetAction) || form.dataset.deleteServiceRequest === 'true';
      });
      forms.forEach((form, index) => {
        if (index > 0) {
          form.remove();
          return;
        }
        form.dataset.deleteServiceRequest = 'true';
        form.onsubmit = (event) => {
          if (!nativeConfirm(confirmText)) event.preventDefault();
        };
        const button = form.querySelector('button');
        if (button) {
          button.textContent = targetAction.slice(1).replace(/^./, (letter) => letter.toUpperCase());
          button.classList.add('btn');
        }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', clean);
  else clean();
  new MutationObserver(clean).observe(document.documentElement, { childList: true, subtree: true });
})();
