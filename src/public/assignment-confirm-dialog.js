(() => {
  const originalConfirm = window.confirm.bind(window);
  const ASSIGNMENT_DATE_KEY = 'loginpro.assignment.dateFilter';
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

  function selectedDateParam() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('fecha') || params.get('date') || '';
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  }

  function rememberSelectedDateFilter() {
    const date = selectedDateParam();
    if (!date) return;
    try { sessionStorage.setItem(ASSIGNMENT_DATE_KEY, JSON.stringify({ date, savedAt: Date.now() })); }
    catch (_error) {}
  }

  function rememberedDateFilter() {
    try {
      const data = JSON.parse(sessionStorage.getItem(ASSIGNMENT_DATE_KEY) || 'null');
      if (!data?.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return '';
      if (Date.now() - Number(data.savedAt || 0) > 10 * 60 * 1000) return '';
      return data.date;
    } catch (_error) { return ''; }
  }

  function restoreDateFilterAfterAssignmentRedirect() {
    if (window.location.pathname !== '/admin/operaciones/asignaciones') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('fecha') || params.get('date')) return false;
    const message = String(params.get('message') || '');
    if (!/auxiliar|asignad|confirmaci|novedad|retirad|cobertura/i.test(message)) return false;
    const date = rememberedDateFilter();
    if (!date) return false;
    params.set('fecha', date);
    window.location.replace(`${window.location.pathname}?${params.toString()}`);
    return true;
  }

  function preserveDateBeforeAssignmentSubmit() {
    const form = document.getElementById('assignForm');
    if (!form || form.dataset.dateFilterPreserved === 'true') return;
    form.dataset.dateFilterPreserved = 'true';
    const nativeSubmit = form.submit.bind(form);
    form.submit = () => { rememberSelectedDateFilter(); nativeSubmit(); };
    form.addEventListener('submit', rememberSelectedDateFilter, true);
  }

  function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

  function assignmentWhatsappButtons() {
    return [...document.querySelectorAll('.assigned-card .dispatch-wa-button, .assigned-card .whatsapp-link, .assigned-card .icon-whatsapp')]
      .filter((button) => button instanceof HTMLElement && !button.closest('[hidden]'));
  }

  async function waitForWhatsappButton(button) {
    const startedAt = Date.now();
    await sleep(150);
    while (button.disabled && Date.now() - startedAt < 30000) await sleep(250);
  }

  function addBulkWhatsappButton() {
    if (document.getElementById('sendAllAssignmentWhatsapp')) return;
    const whatsappButtons = assignmentWhatsappButtons();
    if (!whatsappButtons.length) return;
    const container = document.querySelector('.template-actions') || document.querySelector('.notify-actions') || document.querySelector('.assignment-body');
    if (!container) return;
    const button = document.createElement('button');
    button.id = 'sendAllAssignmentWhatsapp';
    button.className = 'btn btn-primary';
    button.type = 'button';
    button.textContent = 'Enviar WhatsApp a todos';
    button.addEventListener('click', async () => {
      const currentButtons = assignmentWhatsappButtons().filter((item) => !item.disabled);
      if (!currentButtons.length) return;
      if (!originalConfirm(`¿Enviar mensaje de confirmación a ${currentButtons.length} auxiliar(es)?`)) return;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Enviando a todos...';
      for (const item of currentButtons) {
        item.click();
        await waitForWhatsappButton(item);
      }
      button.disabled = false;
      button.textContent = originalText;
    });
    container.appendChild(button);
  }

  if (restoreDateFilterAfterAssignmentRedirect()) return;
  rememberSelectedDateFilter();

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
      .same-day-dialog-confirm{background:#b45309;border-color:#b45309;color:#fff}.same-day-dialog-confirm:hover{background:#92400e;color:#fff}
      .notify-manager-enhanced{display:grid;gap:7px}.notify-manager-controls{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}.notify-manager-controls select,.notify-manager-custom{width:100%;border:1px solid var(--border,#d8e0ea);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;background:#fff;color:var(--navy,#172033)}.notify-manager-add{border:1px solid var(--border,#d8e0ea);border-radius:8px;background:#fff;color:var(--navy,#172033);font-weight:900;padding:7px 10px;cursor:pointer}.notify-pdf-link{width:auto!important;min-width:140px;border-radius:999px!important;padding:7px 12px!important;font-size:12px!important;height:auto!important;text-decoration:none!important;background:#fff!important;color:var(--navy,#172033)!important;border:1px solid var(--border,#d8e0ea)!important}.notify-pdf-link:hover{border-color:#0d7a6b!important;color:#0d7a6b!important}
      @media(max-width:520px){.styled-confirm-actions,.same-day-dialog-actions{display:grid;grid-template-columns:1fr}.styled-confirm-btn,.same-day-dialog-btn{width:100%}.notify-manager-controls{grid-template-columns:1fr}.notify-manager-add{width:100%}}
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

  function enhanceManagedByField() {
    const input = document.getElementById('notifyManagedBy');
    if (!input || input.dataset.enhanced === 'true') return;
    injectSharedDialogStyles();
    input.dataset.enhanced = 'true';
    input.type = 'hidden';
    const field = input.closest('.notify-managed-field');
    const managersKey = 'dispatchProgrammingManagers';
    const getManagers = () => { try { return JSON.parse(localStorage.getItem(managersKey) || '[]'); } catch (_error) { return []; } };
    const setInputValue = (value) => { input.value = String(value || '').trim() || 'Julián Herrera'; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const wrapper = document.createElement('div');
    wrapper.className = 'notify-manager-enhanced';
    wrapper.innerHTML = `
      <div class="notify-manager-controls"><select aria-label="Gestionado por"></select><button class="notify-manager-add" type="button">+</button></div>
      <input class="notify-manager-custom" type="text" maxlength="80" placeholder="Agregar otro nombre" hidden />`;
    field?.insertBefore(wrapper, input);
    const select = wrapper.querySelector('select');
    const addButton = wrapper.querySelector('button');
    const custom = wrapper.querySelector('.notify-manager-custom');
    const renderManagers = (selected = 'Julián Herrera') => { const managers = [...new Set(['Julián Herrera', ...getManagers()])]; select.innerHTML = managers.map((name) => `<option value="${String(name).replace(/"/g, '&quot;')}">${String(name)}</option>`).join(''); select.value = managers.includes(selected) ? selected : 'Julián Herrera'; setInputValue(select.value); };
    const saveManager = () => { const clean = custom.value.trim(); if (!clean) return; const managers = [...new Set([...getManagers(), clean])]; localStorage.setItem(managersKey, JSON.stringify(managers)); custom.value = ''; custom.hidden = true; renderManagers(clean); };
    select.addEventListener('change', () => setInputValue(select.value));
    addButton.addEventListener('click', () => { custom.hidden = false; custom.focus(); });
    custom.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); saveManager(); } });
    custom.addEventListener('blur', saveManager);
    renderManagers();

    const actions = document.querySelector('.notify-actions');
    const selectedRequestId = new URLSearchParams(window.location.search).get('serviceRequestId');
    if (actions && selectedRequestId && !document.getElementById('notifyPdfLink')) {
      const link = document.createElement('a');
      link.id = 'notifyPdfLink';
      link.className = 'notify-pdf-link';
      link.textContent = 'Descargar PDF';
      link.href = '#';
      link.addEventListener('click', () => {
        const params = new URLSearchParams({ requestId: selectedRequestId, managedBy: input.value || 'Julián Herrera' });
        link.href = `/admin/operaciones/programacion.pdf?${params.toString()}`;
      });
      actions.prepend(link);
    }
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
    rememberSelectedDateFilter();
    preserveDateBeforeAssignmentSubmit();
    enhanceManagedByField();
    addBulkWhatsappButton();
    const observer = new MutationObserver(() => { preserveDateBeforeAssignmentSubmit(); addBulkWhatsappButton(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, options = {}) => {
      const url = typeof resource === 'string' ? resource : String(resource?.url || '');
      const bodyText = String(options?.body || '');
      const isAssign = url.includes('/admin/operaciones/asignaciones/assign');
      if (isAssign && bodyText.includes('workerId=')) {
        rememberSelectedDateFilter();
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
