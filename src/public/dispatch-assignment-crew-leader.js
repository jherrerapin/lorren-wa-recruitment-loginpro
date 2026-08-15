'use strict';

(() => {
  const CONFIG_PATH = '/admin/operaciones/asistencia/cuadrillas/config';
  const MODE_CREW = 'CREW';
  let loadSequence = 0;
  let saveInProgress = false;
  let lastBoardSignature = '';

  function assignmentPageActive() {
    return Boolean(document.querySelector('#selectedRequestSummary') && document.querySelector('.assignment-body'));
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
      .crew-assignment-summary.is-disabled{border-color:#f2d085;background:#fff8e7;color:#6b4700}
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
      serviceRequestId: summary?.dataset.serviceRequestId || '',
      serviceDate: summary?.dataset.requestDate || ''
    };
  }

  function boardSignature() {
    if (!assignmentPageActive()) return '';
    const { serviceRequestId, serviceDate } = selectedRequestContext();
    const assignments = [...document.querySelectorAll('.assigned-card')].map((card) => {
      const status = card.querySelector('.assignment-status-line')?.textContent || '';
      return `${card.dataset.workerId || ''}:${status.trim()}`;
    }).join('|');
    return `${serviceRequestId}:${serviceDate}:${assignments}`;
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
    document.querySelectorAll('[data-crew-leader-control] input').forEach((input) => { input.disabled = true; });
    try {
      await requestJson(`/admin/operaciones/asistencia/cuadrillas/servicios/${encodeURIComponent(service.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({
          mode: MODE_CREW,
          crewLeaderWorkerId: selected ? workerId : ''
        })
      });
      showCrewMessage(selected ? 'Encargado de cuadrilla actualizado.' : 'La solicitud quedó sin encargado. Marca otra persona antes de la llegada.');
      lastBoardSignature = '';
      await loadCrewLeaderControls();
    } catch (error) {
      showCrewMessage(error.message || 'No fue posible actualizar el encargado.');
      lastBoardSignature = '';
      await loadCrewLeaderControls();
    } finally {
      saveInProgress = false;
    }
  }

  function renderCrewLeaderControls(service) {
    clearCrewDecorations();
    if (!service || service.mode !== MODE_CREW || service.crewEligible !== true) return;

    const summary = document.getElementById('selectedRequestSummary');
    const meta = summary?.querySelector('.meta');
    if (meta) {
      const line = document.createElement('div');
      line.dataset.crewAssignmentSummary = 'true';
      line.className = `crew-assignment-summary${service.crewAvailable ? '' : ' is-disabled'}`;
      const leaderName = currentLeaderName(service);
      if (!service.crewAvailable) {
        line.textContent = 'Esta solicitud heredó marcación por cuadrilla al crearse, pero la operación está deshabilitada actualmente. Reactívala para cambiar encargado o marcar la cuadrilla.';
      } else {
        line.textContent = leaderName
          ? `Marcación por cuadrilla · Encargado: ${leaderName}. Esta persona hace parte del total requerido.`
          : 'Marcación por cuadrilla heredada desde la operación · Encargado pendiente. Marca una de las personas asignadas; seguirá contando dentro del total requerido.';
      }
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
    if (!assignmentPageActive()) {
      clearCrewDecorations();
      return;
    }
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
      lastBoardSignature = boardSignature();
    } catch (error) {
      if (sequence !== loadSequence) return;
      clearCrewDecorations();
      lastBoardSignature = boardSignature();
      if (error.status !== 403) showCrewMessage(error.message || 'No fue posible cargar la configuración de cuadrilla.');
    }
  }

  function syncWhenBoardChanges() {
    const signature = boardSignature();
    if (!signature || signature === lastBoardSignature || saveInProgress) return;
    lastBoardSignature = signature;
    loadCrewLeaderControls();
  }

  function initializeCrewLeaderAssignment() {
    if (!assignmentPageActive()) return;
    installCrewStyles();
    lastBoardSignature = '';
    syncWhenBoardChanges();
    window.setInterval(syncWhenBoardChanges, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeCrewLeaderAssignment, { once: true });
  else initializeCrewLeaderAssignment();
})();
