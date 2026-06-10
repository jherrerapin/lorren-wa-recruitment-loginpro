(() => {
  const originalConfirm = window.confirm.bind(window);
  let allowNextNativeRemovalConfirm = false;
  const confirmedForms = new WeakSet();

  window.confirm = function styledConfirmProxy(message) {
    const text = String(message || '');
    if (allowNextNativeRemovalConfirm && text.includes('Quitar este auxiliar')) {
      allowNextNativeRemovalConfirm = false;
      return true;
    }
    return originalConfirm(message);
  };

  function injectSharedDialogStyles() {
    if (document.getElementById('styledDialogSharedStyles')) return;
    const style = document.createElement('style');
    style.id = 'styledDialogSharedStyles';
    style.textContent = `
      .styled-confirm-backdrop,.same-day-dialog-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.50);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:18px;z-index:10000}
      .same-day-dialog-backdrop{z-index:10001}
      .styled-confirm-backdrop.is-open,.same-day-dialog-backdrop.is-open{display:flex}
      .styled-confirm-card,.same-day-dialog-card{width:min(440px,100%);background:#fff;border:1px solid #e1e6ef;border-radius:20px;box-shadow:0 24px 70px rgba(15,23,42,.26);overflow:hidden;transform:translateY(6px) scale(.98);opacity:0;transition:opacity .16s ease,transform .16s ease}
      .same-day-dialog-card{border-color:#fde68a}
      .styled-confirm-backdrop.is-open .styled-confirm-card,.same-day-dialog-backdrop.is-open .same-day-dialog-card{transform:translateY(0) scale(1);opacity:1}
      .styled-confirm-head,.same-day-dialog-head{display:flex;gap:12px;align-items:flex-start;padding:18px 18px 10px}
      .styled-confirm-icon,.same-day-dialog-icon{width:38px;height:38px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:24px;flex:0 0 auto}
      .styled-confirm-icon{background:#fff1f2;color:#be123c}.same-day-dialog-icon{background:#fef3c7;color:#b45309}
      .styled-confirm-title,.same-day-dialog-title{margin:0;color:#1e2d3d;font-size:17px;line-height:1.2;font-weight:900}
      .styled-confirm-text,.same-day-dialog-text{margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.45}
      .same-day-dialog-detail{margin-top:10px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:12px;padding:9px 10px;font-size:12px;font-weight:800}
      .styled-confirm-actions,.same-day-dialog-actions{display:flex;justify-content:flex-end;gap:9px;padding:14px 18px 18px;background:#f8fafc;border-top:1px solid #eef2f7}
      .styled-confirm-btn,.same-day-dialog-btn{min-height:36px;border-radius:999px;border:1px solid #e1e6ef;background:#fff;color:#1e2d3d;padding:8px 14px;font-weight:900;font-size:13px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.08)}
      .styled-confirm-btn:hover,.same-day-dialog-btn:hover{border-color:#0d7a6b;color:#0d7a6b}
      .styled-confirm-danger{background:#be123c;border-color:#be123c;color:#fff}.styled-confirm-danger:hover{background:#9f1239;border-color:#9f1239;color:#fff}
      .same-day-dialog-confirm{background:#b45309;border-color:#b45309;color:#fff}.same-day-dialog-confirm:hover{background:#92400e;border-color:#92400e;color:#fff}
      @media(max-width:520px){.styled-confirm-actions,.same-day-dialog-actions{display:grid;grid-template-columns:1fr}.styled-confirm-btn,.same-day-dialog-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureDialog() {
    let dialog = document.getElementById('styledConfirmDialog');
    if (dialog) return dialog;
    injectSharedDialogStyles();
    dialog = document.createElement('div');
    dialog.id = 'styledConfirmDialog';
    dialog.className = 'styled-confirm-backdrop';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'styledConfirmTitle');
    dialog.setAttribute('aria-describedby', 'styledConfirmText');
    dialog.innerHTML = `
      <section class="styled-confirm-card">
        <div class="styled-confirm-head">
          <div class="styled-confirm-icon" aria-hidden="true">−</div>
          <div>
            <h2 class="styled-confirm-title" id="styledConfirmTitle">Quitar auxiliar</h2>
            <p class="styled-confirm-text" id="styledConfirmText">¿Seguro que deseas retirar este auxiliar de la solicitud? Esta acción libera el cupo para asignar a otra persona.</p>
          </div>
        </div>
        <div class="styled-confirm-actions">
          <button class="styled-confirm-btn" type="button" data-cancel>Cancelar</button>
          <button class="styled-confirm-btn styled-confirm-danger" type="button" data-ok>Sí, quitar</button>
        </div>
      </section>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function ensureSameDayDialog() {
    let dialog = document.getElementById('sameDayAssignmentDialog');
    if (dialog) return dialog;
    injectSharedDialogStyles();
    dialog = document.createElement('div');
    dialog.id = 'sameDayAssignmentDialog';
    dialog.className = 'same-day-dialog-backdrop';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
      <section class="same-day-dialog-card">
        <div class="same-day-dialog-head">
          <div class="same-day-dialog-icon" aria-hidden="true">!</div>
          <div>
            <h2 class="same-day-dialog-title">Auxiliar ya asignado este día</h2>
            <p class="same-day-dialog-text">Este auxiliar ya tiene una asignación activa en otra solicitud para la misma fecha.</p>
            <div class="same-day-dialog-detail">¿Deseas asignarlo también a esta solicitud?</div>
          </div>
        </div>
        <div class="same-day-dialog-actions">
          <button class="same-day-dialog-btn" type="button" data-same-day-cancel>No asignar</button>
          <button class="same-day-dialog-btn same-day-dialog-confirm" type="button" data-same-day-ok>Sí, asignar también</button>
        </div>
      </section>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function askRemovalConfirmation() {
    const dialog = ensureDialog();
    dialog.classList.add('is-open');
    const ok = dialog.querySelector('[data-ok]');
    const cancel = dialog.querySelector('[data-cancel]');
    cancel.focus();
    return new Promise((resolve) => {
      const close = (value) => {
        dialog.classList.remove('is-open');
        ok.onclick = null;
        cancel.onclick = null;
        dialog.onclick = null;
        document.onkeydown = null;
        resolve(value);
      };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      dialog.onclick = (event) => { if (event.target === dialog) close(false); };
      document.onkeydown = (event) => { if (event.key === 'Escape') close(false); };
    });
  }

  function askSameDayConfirmation() {
    const dialog = ensureSameDayDialog();
    dialog.classList.add('is-open');
    const ok = dialog.querySelector('[data-same-day-ok]');
    const cancel = dialog.querySelector('[data-same-day-cancel]');
    cancel.focus();
    return new Promise((resolve) => {
      const close = (value) => {
        dialog.classList.remove('is-open');
        ok.onclick = null;
        cancel.onclick = null;
        dialog.onclick = null;
        document.onkeydown = null;
        resolve(value);
      };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      dialog.onclick = (event) => { if (event.target === dialog) close(false); };
      document.onkeydown = (event) => { if (event.key === 'Escape') close(false); };
    });
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.asyncAssignmentAction !== 'unassign') return;
    if (confirmedForms.has(form)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const confirmed = await askRemovalConfirmation();
    if (!confirmed) return;
    confirmedForms.add(form);
    allowNextNativeRemovalConfirm = true;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    window.setTimeout(() => confirmedForms.delete(form), 1000);
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, options = {}) => {
      const url = typeof resource === 'string' ? resource : String(resource?.url || '');
      const bodyText = String(options?.body || '');
      const isAssign = url.includes('/admin/operaciones/asignaciones/assign');
      if (isAssign && bodyText.includes('workerId=')) {
        const params = new URLSearchParams(bodyText);
        const workerId = params.get('workerId');
        const card = workerId ? document.querySelector(`.worker-card[data-worker-id="${CSS.escape(workerId)}"]`) : null;
        if (card?.classList.contains('same-day-assignment')) {
          const confirmed = await askSameDayConfirmation();
          if (!confirmed) return new Response('', { status: 499, statusText: 'same_day_assignment_cancelled' });
        }
      }
      return nativeFetch(resource, options);
    };
  });
})();
