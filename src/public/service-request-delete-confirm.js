(() => {
  const CONFIRM_TEXT = 'Esta acción eliminará la solicitud de servicio y no te sacará de esta página.';
  let activeForm = null;
  let submitting = false;

  function ensureStyles() {
    if (document.getElementById('serviceRequestDeleteConfirmStyles')) return;
    const style = document.createElement('style');
    style.id = 'serviceRequestDeleteConfirmStyles';
    style.textContent = `
      .service-delete-backdrop{position:fixed;inset:0;z-index:10020;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(15,23,42,.52);backdrop-filter:blur(3px)}
      .service-delete-backdrop.is-open{display:flex}
      .service-delete-card{width:min(460px,100%);overflow:hidden;border:1px solid #fecaca;border-radius:22px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.28);opacity:0;transform:translateY(8px) scale(.98);transition:opacity .16s ease,transform .16s ease}
      .service-delete-backdrop.is-open .service-delete-card{opacity:1;transform:translateY(0) scale(1)}
      .service-delete-head{display:flex;gap:13px;align-items:flex-start;padding:20px 20px 12px}
      .service-delete-icon{width:42px;height:42px;flex:0 0 auto;border-radius:999px;background:#fff1f2;color:#be123c;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:900}
      .service-delete-title{margin:0;color:#172033;font-size:18px;line-height:1.2;font-weight:900}
      .service-delete-text{margin:7px 0 0;color:#64748b;font-size:13px;line-height:1.45}
      .service-delete-note{margin-top:11px;border:1px solid #e2e8f0;border-radius:13px;background:#f8fafc;color:#334155;padding:9px 10px;font-size:12px;font-weight:800}
      .service-delete-actions{display:flex;justify-content:flex-end;gap:9px;padding:15px 20px 20px;background:#f8fafc;border-top:1px solid #eef2f7}
      .service-delete-btn{min-height:38px;border-radius:999px;border:1px solid #d8e0ea;background:#fff;color:#172033;padding:8px 15px;font-weight:900;font-size:13px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.08)}
      .service-delete-btn:hover{border-color:#0d7a6b;color:#0d7a6b}
      .service-delete-danger{background:#be123c;border-color:#be123c;color:#fff}.service-delete-danger:hover{background:#9f1239;border-color:#9f1239;color:#fff}
      .service-delete-danger:disabled{opacity:.7;cursor:wait}
      .service-request-removing{opacity:.55;transform:scale(.995);transition:opacity .16s ease,transform .16s ease}
      .async-toast{position:fixed;right:18px;bottom:18px;max-width:340px;background:#172033;color:#fff;border-radius:14px;padding:11px 13px;box-shadow:0 12px 30px rgba(15,23,42,.22);font-size:13px;line-height:1.35;z-index:10030;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}.async-toast.show{opacity:1;transform:translateY(0)}
      @media(max-width:520px){.service-delete-actions{display:grid;grid-template-columns:1fr}.service-delete-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureDialog() {
    let dialog = document.getElementById('serviceRequestDeleteConfirm');
    if (dialog) return dialog;
    ensureStyles();
    dialog = document.createElement('div');
    dialog.id = 'serviceRequestDeleteConfirm';
    dialog.className = 'service-delete-backdrop';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'serviceDeleteTitle');
    dialog.setAttribute('aria-describedby', 'serviceDeleteText');
    dialog.innerHTML = `
      <section class="service-delete-card">
        <div class="service-delete-head">
          <div class="service-delete-icon" aria-hidden="true">×</div>
          <div>
            <h2 class="service-delete-title" id="serviceDeleteTitle">Eliminar solicitud</h2>
            <p class="service-delete-text" id="serviceDeleteText">${CONFIRM_TEXT}</p>
            <div class="service-delete-note">Permanecerás en la página actual. Quitaremos la tarjeta cuando la eliminación sea exitosa.</div>
          </div>
        </div>
        <div class="service-delete-actions">
          <button class="service-delete-btn" type="button" data-service-delete-cancel>Cancelar</button>
          <button class="service-delete-btn service-delete-danger" type="button" data-service-delete-ok>Sí, eliminar</button>
        </div>
      </section>`;
    document.body.appendChild(dialog);
    dialog.querySelector('[data-service-delete-cancel]')?.addEventListener('click', closeDialog);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDialog(); });
    dialog.querySelector('[data-service-delete-ok]')?.addEventListener('click', submitActiveForm);
    return dialog;
  }

  function closeDialog() {
    if (submitting) return;
    const dialog = document.getElementById('serviceRequestDeleteConfirm');
    dialog?.classList.remove('is-open');
    activeForm = null;
  }

  function openDialog(form) {
    activeForm = form;
    const dialog = ensureDialog();
    dialog.classList.add('is-open');
    window.setTimeout(() => dialog.querySelector('[data-service-delete-cancel]')?.focus(), 30);
  }

  function showInlineMessage(message) {
    if (typeof window.showToast === 'function') return window.showToast(message);
    const toast = document.getElementById('asyncToast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      window.clearTimeout(showInlineMessage._timer);
      showInlineMessage._timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
    }
  }

  async function submitActiveForm() {
    const form = activeForm;
    if (!form || submitting) return;
    submitting = true;
    const dialog = ensureDialog();
    const ok = dialog.querySelector('[data-service-delete-ok]');
    const originalText = ok?.textContent || 'Sí, eliminar';
    if (ok) {
      ok.disabled = true;
      ok.textContent = 'Eliminando...';
    }
    const card = form.closest('article, .request-card, .request, tr');
    card?.classList.add('service-request-removing');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new URLSearchParams(new FormData(form)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Requested-With': 'fetch' },
        redirect: 'follow'
      });
      if (!response.ok) throw new Error('No fue posible eliminar la solicitud.');
      dialog.classList.remove('is-open');
      card?.remove();
      showInlineMessage('Solicitud eliminada. Sigues en esta página.');
    } catch (error) {
      card?.classList.remove('service-request-removing');
      showInlineMessage(error.message || 'No fue posible eliminar la solicitud.');
    } finally {
      submitting = false;
      activeForm = null;
      if (ok) {
        ok.disabled = false;
        ok.textContent = originalText;
      }
    }
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.matches('form[action*="/admin/operaciones/solicitudes/"][action$="/eliminar"], form[data-delete-service-request="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openDialog(form);
  }, true);
})();
