'use strict';

(function installServiceRequestDeleteConfirmation() {
  const CONFIRM_TEXT = '¿Seguro que deseas eliminar esta solicitud de servicio?';
  const DIALOG_SCRIPT = '/public/lorren-dialog.js';
  let dialogLoader = null;
  let submitting = false;

  function ensureStyles() {
    if (document.getElementById('serviceRequestDeleteActionStyles')) return;
    const style = document.createElement('style');
    style.id = 'serviceRequestDeleteActionStyles';
    style.textContent = `
      .service-request-removing{opacity:.55;transform:scale(.995);transition:opacity .16s ease,transform .16s ease}
      .async-toast{position:fixed;right:18px;bottom:18px;max-width:340px;background:#172033;color:#fff;border-radius:14px;padding:11px 13px;box-shadow:0 12px 30px rgba(15,23,42,.22);font-size:13px;line-height:1.35;z-index:10030;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}.async-toast.show{opacity:1;transform:translateY(0)}
    `;
    document.head.appendChild(style);
  }

  function ensureLorrenDialog() {
    if (window.LorrenDialog?.confirm) return Promise.resolve(window.LorrenDialog);
    if (dialogLoader) return dialogLoader;

    dialogLoader = new Promise((resolve, reject) => {
      let script = document.querySelector(`script[src="${DIALOG_SCRIPT}"]`);
      const done = () => {
        if (window.LorrenDialog?.confirm) resolve(window.LorrenDialog);
        else reject(new Error('No fue posible cargar la confirmación visual.'));
      };
      if (script) {
        script.addEventListener('load', done, { once: true });
        script.addEventListener('error', () => reject(new Error('No fue posible cargar la confirmación visual.')), { once: true });
        window.setTimeout(() => {
          if (window.LorrenDialog?.confirm) resolve(window.LorrenDialog);
        }, 0);
        return;
      }

      script = document.createElement('script');
      script.src = DIALOG_SCRIPT;
      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', () => reject(new Error('No fue posible cargar la confirmación visual.')), { once: true });
      document.head.appendChild(script);
    }).finally(() => {
      if (!window.LorrenDialog?.confirm) dialogLoader = null;
    });

    return dialogLoader;
  }

  function showInlineMessage(message) {
    if (typeof window.showToast === 'function') return window.showToast(message);
    const toast = document.getElementById('asyncToast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      window.clearTimeout(showInlineMessage._timer);
      showInlineMessage._timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
      return;
    }
    console.error(message);
  }

  async function submitDelete(form) {
    if (!form || submitting) return;
    submitting = true;
    const card = form.closest('article, .request-card, .request, tr');
    const submitButton = form.querySelector('button[type="submit"], button:not([type])');
    const originalText = submitButton?.textContent || '';
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Eliminando...';
    }
    card?.classList.add('service-request-removing');

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new URLSearchParams(new FormData(form)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Requested-With': 'fetch' },
        redirect: 'follow'
      });
      if (!response.ok) throw new Error('No fue posible eliminar la solicitud.');
      card?.remove();
      showInlineMessage('Solicitud eliminada.');
    } catch (error) {
      card?.classList.remove('service-request-removing');
      showInlineMessage(error.message || 'No fue posible eliminar la solicitud.');
    } finally {
      submitting = false;
      if (submitButton && document.contains(submitButton)) {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    }
  }

  async function confirmDelete(form) {
    try {
      const dialog = await ensureLorrenDialog();
      return await dialog.confirm({
        tone: 'danger',
        title: 'Eliminar solicitud',
        text: CONFIRM_TEXT,
        cancelLabel: 'Cancelar',
        confirmLabel: 'Sí, eliminar'
      });
    } catch (error) {
      showInlineMessage(error.message || 'No fue posible mostrar la confirmación.');
      return false;
    }
  }

  ensureStyles();
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.matches('form[action*="/admin/operaciones/solicitudes/"][action$="/eliminar"], form[data-delete-service-request="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (submitting) return;
    const confirmed = await confirmDelete(form);
    if (confirmed) await submitDelete(form);
  }, true);
})();

(() => {
  if (!document.querySelector('.assignment-page')) return;
  if (document.querySelector('script[data-dispatch-assignment-crew-leader]')) return;
  const script = document.createElement('script');
  script.src = '/public/dispatch-assignment-crew-leader.js';
  script.dataset.dispatchAssignmentCrewLeader = 'true';
  document.head.appendChild(script);
})();
