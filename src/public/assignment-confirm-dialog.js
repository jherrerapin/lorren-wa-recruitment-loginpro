(() => {
  const originalConfirm = window.confirm.bind(window);
  const ASSIGNMENT_DATE_KEY = 'loginpro.assignment.dateFilter';
  const WHATSAPP_ICON_STYLE_ID = 'dispatchWhatsappIconOnlyStyle';
  let allowNextNativeRemovalConfirm = false;

  window.confirm = function styledConfirmProxy(message) {
    const text = String(message || '');
    if (allowNextNativeRemovalConfirm && text.includes('Quitar este auxiliar')) {
      allowNextNativeRemovalConfirm = false;
      return true;
    }
    return originalConfirm(message);
  };

  function injectWhatsappButtonStyle() {
    if (document.getElementById(WHATSAPP_ICON_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = WHATSAPP_ICON_STYLE_ID;
    style.textContent = `
      .assignment-page .icon-whatsapp,
      .assignment-page .dispatch-wa-button.whatsapp-link {
        width: 30px !important;
        height: 30px !important;
        min-width: 30px !important;
        min-height: 30px !important;
        padding: 0 !important;
        border-radius: 999px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: #25D366 !important;
        border-color: #25D366 !important;
        color: transparent !important;
        font-size: 0 !important;
        line-height: 0 !important;
        overflow: hidden !important;
      }
      .assignment-page .icon-whatsapp::before,
      .assignment-page .dispatch-wa-button.whatsapp-link::before {
        content: '' !important;
        display: block !important;
        width: 18px !important;
        height: 18px !important;
        background-repeat: no-repeat !important;
        background-position: center !important;
        background-size: contain !important;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 448 512'%3E%3Cpath fill='white' d='M380.9 97.1C339 55.1 283.2 32 223.9 32 101 32 1 132 1 255c0 39.2 10.2 77.4 29.6 111L0 480l116.7-30.6c32.4 17.7 68.9 27 106.1 27h.1c122.9 0 222.9-100 222.9-223 0-59.3-23.1-115.1-65-157.3zM223 438.7h-.1c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.2 18.2 18.5-67.5-4.4-6.9c-18.5-29.4-28.3-63.3-28.3-98.1 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 54 81.2 53.9 130.5 0 101.8-82.8 184.6-184.7 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.5-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.5-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z'/%3E%3C/svg%3E") !important;
      }
    `;
    document.head.appendChild(style);
  }

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

  function markFinalAssignmentCard(card) {
    if (!card) return;
    const statusText = String(card.querySelector('.assignment-status-line')?.textContent || '').toLowerCase();
    const hasDecisionButtons = Boolean(card.querySelector('form[data-async-assignment-action="confirmar"],form[data-async-assignment-action="no-confirmado"]'));
    const isFinal = !hasDecisionButtons && (
      statusText.includes('estado: confirmado')
      || statusText.includes('estado: no confirmó')
      || statusText.includes('estado: no confirmado')
    );
    card.classList.toggle('assignment-final-card', isFinal);
  }

  function markInitialFinalAssignmentCards() {
    document.querySelectorAll('.assigned-card').forEach(markFinalAssignmentCard);
  }

  function encodeForm(form) {
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => params.append(key, value));
    return params;
  }

  function showInlineToast(message) {
    if (!message) return;
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }
    const toast = document.getElementById('asyncToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showInlineToast._timer);
    showInlineToast._timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function stopBoardReloadAfterAction() {
    window.refreshBoardAfterAction = (message) => showInlineToast(message);
  }

  function disableActionButtons(container, disabled) {
    Array.from(container?.querySelectorAll('button,a') || []).forEach((button) => {
      if (disabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      } else {
        button.disabled = false;
        button.removeAttribute('aria-disabled');
      }
    });
  }

  async function submitAssignmentActionWithoutReload(form) {
    const action = form.dataset.asyncAssignmentAction;
    const card = form.closest('.assigned-card');
    if (!action || !card) return false;
    if (action === 'unassign') {
      const confirmed = await askRemovalConfirmation();
      if (!confirmed) return true;
    }
    const actions = form.closest('.assigned-actions');
    card.classList.add('is-updating');
    disableActionButtons(actions, true);
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: encodeForm(form),
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'fetch'
        }
      });
      if (!response.ok) throw new Error('No fue posible completar la acción.');
      const statusLine = card.querySelector('.assignment-status-line');
      if (action === 'unassign') {
        card.classList.add('is-removed');
        window.setTimeout(() => card.remove(), 160);
        showInlineToast('Auxiliar retirado de la solicitud.');
        return true;
      }
      if (action === 'confirmar') {
        if (statusLine) statusLine.textContent = 'Estado: Confirmado';
        actions?.querySelectorAll('form[data-async-assignment-action="confirmar"],form[data-async-assignment-action="no-confirmado"]').forEach((item) => item.remove());
        markFinalAssignmentCard(card);
        showInlineToast('Confirmación registrada.');
        return true;
      }
      if (action === 'no-confirmado') {
        if (statusLine) statusLine.textContent = 'Estado: No confirmó';
        actions?.querySelectorAll('form[data-async-assignment-action="confirmar"],form[data-async-assignment-action="no-confirmado"]').forEach((item) => item.remove());
        markFinalAssignmentCard(card);
        showInlineToast('Auxiliar marcado como no confirmado.');
        return true;
      }
    } catch (error) {
      console.error(error);
      showInlineToast(error.message || 'No fue posible completar la acción.');
      disableActionButtons(actions, false);
    } finally {
      card.classList.remove('is-updating');
    }
    return true;
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
    if (!form.dataset.asyncAssignmentAction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    await submitAssignmentActionWithoutReload(form);
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    injectWhatsappButtonStyle();
    rememberSelectedDateFilter();
    preserveDateBeforeAssignmentSubmit();
    stopBoardReloadAfterAction();
    enhanceManagedByField();
    markInitialFinalAssignmentCards();
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
