(() => {
  const CONFIRM_TEXT = '¿Seguro que deseas eliminar esta solicitud de servicio?';
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
      showInlineMessage('Solicitud eliminada.');
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

(() => {
  const CONFIG_PATH = '/admin/operaciones/asistencia/cuadrillas/config';
  const MODE_CREW = 'CREW';
  const PANEL_SELECTOR = '.assignment-body';
  let loadSequence = 0;
  let saveInProgress = false;

  function assignmentPageActive() {
    return Boolean(document.querySelector('#selectedRequestSummary') && document.querySelector(PANEL_SELECTOR));
  }

  function showCrewMessage(message) {
    const toast = document.getElementById('asyncToast');
    if (!toast || !message) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showCrewMessage._timer);
    showCrewMessage._timer = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function installCrewStyles() {
    if (document.getElementById('crewLeaderAssignmentStyles')) return;
    const style = document.createElement('style');
    style.id = 'crewLeaderAssignmentStyles';
    style.textContent = `
      .crew-assignment-summary{margin-top:7px;padding:7px 9px;border:1px solid #99f6e4;border-radius:9px;background:#f0fdfa;color:#115e59;font-size:10.5px;font-weight:800;line-height:1.35}
      .crew-leader-control{display:flex;align-items:flex-start;gap:6px;margin-top:5px;padding:6px 7px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#334155;font-size:10px;font-weight:800;line-height:1.25;cursor:pointer}
      .crew-leader-control input{width:15px;height:15px;margin:0;accent-color:#0d7a6b;flex:0 0 auto}
      .crew-leader-control.is-current{border-color:#14b8a6;background:#f0fdfa;color:#115e59}
      .crew-leader-control.is-disabled{opacity:.68;cursor:not-allowed}
      .crew-leader-badge{display:inline-flex;align-items:center;width:max-content;max-width:100%;margin-top:4px;padding:2px 7px;border-radius:999px;background:#0f766e;color:#fff;font-size:9px;font-weight:900;line-height:1.2}
    `;
    document.head.appendChild(style);
  }

  function selectedRequestContext() {
    const summary = document.getElementById('selectedRequestSummary');
    return {
      summary,
      serviceRequestId: summary?.dataset.serviceRequestId || '',
      serviceDate: summary?.dataset.requestDate || ''
    };
  }

  function clearCrewDecorations() {
    document.querySelectorAll('[data-crew-assignment-summary], [data-crew-leader-control], [data-crew-leader-badge]')
      .forEach((node) => node.remove());
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options
    });
    let payload = null;
    try { payload = await response.json(); } catch (_error) { payload = null; }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || 'No fue posible guardar el encargado de cuadrilla.');
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  function currentLeaderName(service) {
    if (!service?.crewLeaderWorkerId) return null;
    return service.assignments?.find((assignment) => assignment.workerId === service.crewLeaderWorkerId)?.fullName || null;
  }

  async function saveLeader(service, workerId, selected) {
    if (saveInProgress) return;
    saveInProgress = true;
    const controls = [...document.querySelectorAll('[data-crew-leader-control] input')];
    controls.forEach((input) => { input.disabled = true; });
    try {
      await requestJson(`/admin/operaciones/asistencia/cuadrillas/servicios/${encodeURIComponent(service.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({
          mode: MODE_CREW,
          crewLeaderWorkerId: selected ? workerId : ''
        })
      });
      showCrewMessage(selected ? 'Encargado de cuadrilla actualizado.' : 'El turno quedó sin encargado. Marca otra persona antes de la llegada.');
      await loadCrewLeaderControls();
    } catch (error) {
      showCrewMessage(error.message || 'No fue posible actualizar el encargado.');
      await loadCrewLeaderControls();
    } finally {
      saveInProgress = false;
    }
  }

  function renderCrewLeaderControls(service) {
    clearCrewDecorations();
    if (!service || service.mode !== MODE_CREW) return;

    const summary = document.getElementById('selectedRequestSummary');
    const meta = summary?.querySelector('.meta');
    if (meta) {
      const line = document.createElement('div');
      line.dataset.crewAssignmentSummary = 'true';
      line.className = 'crew-assignment-summary';
      const leaderName = currentLeaderName(service);
      line.textContent = leaderName
        ? `Marcación por cuadrilla · Encargado: ${leaderName}. Esta persona hace parte del total requerido.`
        : 'Marcación por cuadrilla · Encargado pendiente. Marca una de las personas asignadas; seguirá contando dentro del total requerido.';
      meta.insertAdjacentElement('afterend', line);
    }

    const activeWorkerIds = new Set((service.assignments || []).map((assignment) => assignment.workerId));
    document.querySelectorAll('.assigned-card').forEach((card) => {
      const workerId = card.dataset.workerId || '';
      if (!activeWorkerIds.has(workerId)) return;
      const main = card.querySelector('.assigned-main');
      if (!main) return;
      const current = service.crewLeaderWorkerId === workerId;

      const control = document.createElement('label');
      control.dataset.crewLeaderControl = 'true';
      control.className = `crew-leader-control${current ? ' is-current' : ''}${service.crewAvailable ? '' : ' is-disabled'}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = current;
      checkbox.disabled = !service.crewAvailable;
      checkbox.setAttribute('aria-label', `Encargado de cuadrilla: ${card.dataset.workerName || 'persona asignada'}`);
      const text = document.createElement('span');
      text.textContent = 'Encargado de cuadrilla';
      control.append(checkbox, text);
      main.appendChild(control);

      if (current) {
        const badge = document.createElement('span');
        badge.dataset.crewLeaderBadge = 'true';
        badge.className = 'crew-leader-badge';
        badge.textContent = 'Encargado / Líder de cuadrilla';
        main.appendChild(badge);
      }

      checkbox.addEventListener('change', () => saveLeader(service, workerId, checkbox.checked));
    });
  }

  async function loadCrewLeaderControls() {
    if (!assignmentPageActive()) return;
    const { serviceRequestId, serviceDate } = selectedRequestContext();
    if (!serviceRequestId || !serviceDate) {
      clearCrewDecorations();
      return;
    }
    const sequence = ++loadSequence;
    try {
      const params = new URLSearchParams({ from: serviceDate, to: serviceDate });
      const configuration = await requestJson(`${CONFIG_PATH}?${params.toString()}`);
      if (sequence !== loadSequence) return;
      const service = (configuration.services || []).find((item) => item.id === serviceRequestId) || null;
      renderCrewLeaderControls(service);
    } catch (error) {
      if (sequence !== loadSequence) return;
      clearCrewDecorations();
      if (error.status !== 403) showCrewMessage(error.message || 'No fue posible cargar la configuración de cuadrilla.');
    }
  }

  function observeAssignmentBoard() {
    if (!assignmentPageActive()) return;
    installCrewStyles();
    loadCrewLeaderControls();
    const body = document.querySelector(PANEL_SELECTOR);
    if (!body) return;
    const observer = new MutationObserver(() => {
      window.clearTimeout(observeAssignmentBoard._timer);
      observeAssignmentBoard._timer = window.setTimeout(loadCrewLeaderControls, 60);
    });
    observer.observe(body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeAssignmentBoard, { once: true });
  else observeAssignmentBoard();
})();
