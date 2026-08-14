'use strict';

(function installLorrenDialog() {
  if (window.LorrenDialog?.confirm && window.LorrenDialog?.prompt) return;

  const STYLE_ID = 'lorrenDialogStyles';
  const DIALOG_ID = 'lorrenDialog';
  let activeClose = null;
  let previousFocus = null;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .lorren-dialog-backdrop{position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(15,23,42,.52);backdrop-filter:blur(3px)}
      .lorren-dialog-backdrop.is-open{display:flex}
      .lorren-dialog-card{width:min(460px,100%);overflow:hidden;border:1px solid #e1e6ef;border-radius:22px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.28);opacity:0;transform:translateY(8px) scale(.98);transition:opacity .16s ease,transform .16s ease}
      .lorren-dialog-backdrop.is-open .lorren-dialog-card{opacity:1;transform:translateY(0) scale(1)}
      .lorren-dialog-head{display:flex;gap:13px;align-items:flex-start;padding:20px 20px 12px}
      .lorren-dialog-icon{width:42px;height:42px;flex:0 0 auto;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;background:#eef2f7;color:#475569}
      .lorren-dialog-backdrop[data-tone="danger"] .lorren-dialog-icon{background:#fff1f2;color:#be123c}
      .lorren-dialog-backdrop[data-tone="warning"] .lorren-dialog-icon{background:#fef3c7;color:#b45309}
      .lorren-dialog-title{margin:0;color:#172033;font-size:18px;line-height:1.2;font-weight:900}
      .lorren-dialog-text{margin:7px 0 0;color:#64748b;font-size:13px;line-height:1.45}
      .lorren-dialog-input-wrap{display:grid;gap:6px;padding:0 20px 16px}
      .lorren-dialog-input-wrap[hidden]{display:none}
      .lorren-dialog-input-label{color:#334155;font-size:12px;font-weight:900}
      .lorren-dialog-input{width:100%;min-height:42px;border:1px solid #d8e0ea;border-radius:11px;background:#fff;color:#172033;padding:9px 11px;font:inherit}
      .lorren-dialog-input:focus{outline:3px solid rgba(13,122,107,.14);border-color:#0d7a6b}
      .lorren-dialog-error{min-height:16px;margin:0;color:#be123c;font-size:11px;font-weight:800}
      .lorren-dialog-actions{display:flex;justify-content:flex-end;gap:9px;padding:15px 20px 20px;background:#f8fafc;border-top:1px solid #eef2f7}
      .lorren-dialog-btn{min-height:38px;border-radius:999px;border:1px solid #d8e0ea;background:#fff;color:#172033;padding:8px 15px;font-weight:900;font-size:13px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.08)}
      .lorren-dialog-btn:hover{border-color:#0d7a6b;color:#0d7a6b}
      .lorren-dialog-confirm{background:#0d7a6b;border-color:#0d7a6b;color:#fff}.lorren-dialog-confirm:hover{background:#08685b;border-color:#08685b;color:#fff}
      .lorren-dialog-backdrop[data-tone="danger"] .lorren-dialog-confirm{background:#be123c;border-color:#be123c;color:#fff}.lorren-dialog-backdrop[data-tone="danger"] .lorren-dialog-confirm:hover{background:#9f1239;border-color:#9f1239;color:#fff}
      .lorren-dialog-backdrop[data-tone="warning"] .lorren-dialog-confirm{background:#b45309;border-color:#b45309;color:#fff}.lorren-dialog-backdrop[data-tone="warning"] .lorren-dialog-confirm:hover{background:#92400e;border-color:#92400e;color:#fff}
      @media(max-width:520px){.lorren-dialog-actions{display:grid;grid-template-columns:1fr}.lorren-dialog-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureDialog() {
    let dialog = document.getElementById(DIALOG_ID);
    if (dialog) return dialog;
    ensureStyles();
    dialog = document.createElement('div');
    dialog.id = DIALOG_ID;
    dialog.className = 'lorren-dialog-backdrop';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'lorrenDialogTitle');
    dialog.setAttribute('aria-describedby', 'lorrenDialogText');
    dialog.innerHTML = `
      <section class="lorren-dialog-card">
        <div class="lorren-dialog-head">
          <div class="lorren-dialog-icon" aria-hidden="true" data-lorren-dialog-icon>!</div>
          <div>
            <h2 class="lorren-dialog-title" id="lorrenDialogTitle">Confirmar acción</h2>
            <p class="lorren-dialog-text" id="lorrenDialogText">¿Deseas continuar?</p>
          </div>
        </div>
        <label class="lorren-dialog-input-wrap" data-lorren-dialog-input-wrap hidden>
          <span class="lorren-dialog-input-label" data-lorren-dialog-input-label>Valor</span>
          <input class="lorren-dialog-input" type="text" data-lorren-dialog-input />
          <span class="lorren-dialog-error" data-lorren-dialog-error aria-live="polite"></span>
        </label>
        <div class="lorren-dialog-actions">
          <button class="lorren-dialog-btn" type="button" data-lorren-dialog-cancel>Cancelar</button>
          <button class="lorren-dialog-btn lorren-dialog-confirm" type="button" data-lorren-dialog-ok>Sí, continuar</button>
        </div>
      </section>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function restoreFocus() {
    if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) previousFocus.focus();
    previousFocus = null;
  }

  function closeActive(value) {
    if (typeof activeClose === 'function') activeClose(value);
  }

  function configure(options = {}, { withInput = false } = {}) {
    const dialog = ensureDialog();
    const title = dialog.querySelector('#lorrenDialogTitle');
    const text = dialog.querySelector('#lorrenDialogText');
    const icon = dialog.querySelector('[data-lorren-dialog-icon]');
    const ok = dialog.querySelector('[data-lorren-dialog-ok]');
    const cancel = dialog.querySelector('[data-lorren-dialog-cancel]');
    const inputWrap = dialog.querySelector('[data-lorren-dialog-input-wrap]');
    const inputLabel = dialog.querySelector('[data-lorren-dialog-input-label]');
    const input = dialog.querySelector('[data-lorren-dialog-input]');
    const error = dialog.querySelector('[data-lorren-dialog-error]');
    const tone = ['danger', 'warning'].includes(options.tone) ? options.tone : 'default';

    dialog.dataset.tone = tone;
    title.textContent = options.title || 'Confirmar acción';
    text.textContent = options.text || '¿Deseas continuar?';
    icon.textContent = options.icon || (tone === 'danger' ? '×' : '!');
    ok.textContent = options.confirmLabel || 'Sí, continuar';
    cancel.textContent = options.cancelLabel || 'Cancelar';
    inputWrap.hidden = !withInput;
    inputLabel.textContent = options.inputLabel || 'Valor';
    input.value = withInput ? String(options.value || '') : '';
    input.placeholder = withInput ? String(options.placeholder || '') : '';
    input.maxLength = Number.isFinite(Number(options.maxLength)) ? Math.max(1, Number(options.maxLength)) : 500;
    error.textContent = '';
    return { dialog, ok, cancel, input, error };
  }

  function runDialog(options = {}, { withInput = false } = {}) {
    if (activeClose) closeActive(withInput ? null : false);
    const controls = configure(options, { withInput });
    const { dialog, ok, cancel, input, error } = controls;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.classList.add('is-open');

    return new Promise((resolve) => {
      const cleanup = (value) => {
        dialog.classList.remove('is-open');
        ok.onclick = null;
        cancel.onclick = null;
        dialog.onclick = null;
        document.removeEventListener('keydown', onKeydown, true);
        activeClose = null;
        restoreFocus();
        resolve(value);
      };
      const submit = () => {
        if (!withInput) return cleanup(true);
        const value = input.value.trim();
        if (options.required !== false && !value) {
          error.textContent = options.requiredMessage || 'Completa este campo para continuar.';
          input.focus();
          return;
        }
        cleanup(value);
      };
      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(withInput ? null : false);
        } else if (withInput && event.key === 'Enter' && event.target === input) {
          event.preventDefault();
          submit();
        }
      };

      activeClose = cleanup;
      ok.onclick = submit;
      cancel.onclick = () => cleanup(withInput ? null : false);
      dialog.onclick = (event) => { if (event.target === dialog) cleanup(withInput ? null : false); };
      document.addEventListener('keydown', onKeydown, true);
      window.setTimeout(() => (withInput ? input : cancel).focus(), 20);
    });
  }

  window.LorrenDialog = Object.freeze({
    confirm(options = {}) {
      return runDialog(options, { withInput: false });
    },
    prompt(options = {}) {
      return runDialog(options, { withInput: true });
    }
  });
})();
