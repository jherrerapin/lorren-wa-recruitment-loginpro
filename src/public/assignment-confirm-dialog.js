(() => {
  function ensureDialog() {
    let dialog = document.getElementById('styledConfirmDialog');
    if (dialog) return dialog;

    const style = document.createElement('style');
    style.textContent = `
      .styled-confirm-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.48);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:18px;z-index:10000}
      .styled-confirm-backdrop.is-open{display:flex}
      .styled-confirm-card{width:min(420px,100%);background:#fff;border:1px solid #e1e6ef;border-radius:20px;box-shadow:0 24px 70px rgba(15,23,42,.26);overflow:hidden}
      .styled-confirm-head{display:flex;gap:12px;align-items:flex-start;padding:18px 18px 10px}
      .styled-confirm-icon{width:38px;height:38px;border-radius:999px;background:#fff1f2;color:#be123c;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:24px;flex:0 0 auto}
      .styled-confirm-title{margin:0;color:#1e2d3d;font-size:17px;line-height:1.2;font-weight:900}
      .styled-confirm-text{margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.45}
      .styled-confirm-actions{display:flex;justify-content:flex-end;gap:9px;padding:14px 18px 18px;background:#f8fafc;border-top:1px solid #eef2f7}
      .styled-confirm-btn{min-height:36px;border-radius:999px;border:1px solid #e1e6ef;background:#fff;color:#1e2d3d;padding:8px 14px;font-weight:900;font-size:13px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.08)}
      .styled-confirm-danger{background:#be123c;border-color:#be123c;color:#fff}
    `;
    document.head.appendChild(style);

    dialog = document.createElement('div');
    dialog.id = 'styledConfirmDialog';
    dialog.className = 'styled-confirm-backdrop';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<section class="styled-confirm-card"><div class="styled-confirm-head"><div class="styled-confirm-icon">−</div><div><h2 class="styled-confirm-title">Quitar auxiliar</h2><p class="styled-confirm-text">¿Seguro que deseas retirar este auxiliar de la solicitud?</p></div></div><div class="styled-confirm-actions"><button class="styled-confirm-btn" type="button" data-cancel>Cancelar</button><button class="styled-confirm-btn styled-confirm-danger" type="button" data-ok>Sí, quitar</button></div></section>';
    document.body.appendChild(dialog);
    return dialog;
  }

  window.confirmStyledRemoval = function confirmStyledRemoval() {
    const dialog = ensureDialog();
    dialog.classList.add('is-open');
    return new Promise((resolve) => {
      const ok = dialog.querySelector('[data-ok]');
      const cancel = dialog.querySelector('[data-cancel]');
      const close = (value) => {
        dialog.classList.remove('is-open');
        ok.onclick = null;
        cancel.onclick = null;
        resolve(value);
      };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      cancel.focus();
    });
  };
})();
