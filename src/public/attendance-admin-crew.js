'use strict';

(() => {
  const PANEL_FLAG = '__lorrenCrewAttendanceOperationPanelsInstalled';
  const CONFIG_PATH = '/admin/operaciones/asistencia/cuadrillas/config';
  const MODE_INDIVIDUAL = 'INDIVIDUAL';
  const MODE_CREW = 'CREW';
  const DEFAULT_RANGE_DAYS = 30;
  const states = new WeakMap();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function installStyles() {
    if (document.querySelector('style[data-crew-attendance-operation-styles]')) return;
    const style = document.createElement('style');
    style.dataset.crewAttendanceOperationStyles = 'true';
    style.textContent = `
      .crew-operation-panel{margin-top:16px;padding-top:16px;border-top:1px solid #dfe6ec;display:grid;gap:12px}
      .crew-operation-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .crew-operation-title h4{margin:0;color:var(--navy);font-size:15px}.crew-operation-title p{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.45;max-width:760px}
      .crew-operation-status{min-height:18px;font-size:12px;font-weight:800;color:#166534}.crew-operation-status.is-error{color:#b91c1c}
      .crew-operation-capability{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc}
      .crew-operation-capability input{width:18px;height:18px;margin-top:1px;accent-color:var(--teal);flex:0 0 auto}.crew-operation-capability strong{display:block;color:#243342;font-size:13px}.crew-operation-capability small{display:block;margin-top:3px;color:var(--muted);font-size:11px;line-height:1.4}
      .crew-operation-range{display:grid;grid-template-columns:minmax(150px,1fr) minmax(150px,1fr) auto;gap:9px;align-items:end}.crew-operation-range .field{gap:4px}.crew-operation-range button{white-space:nowrap}
      .crew-operation-service{padding:12px;border:1px solid #dfe6ec;border-radius:12px;background:#fff;display:grid;gap:10px}
      .crew-operation-service-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(180px,.8fr);gap:9px}.crew-operation-service-grid .field{gap:4px}
      .crew-operation-summary{padding:9px 10px;border:1px solid #dbeafe;border-radius:9px;background:#f8fbff;color:#334155;font-size:11px;line-height:1.45}
      .crew-operation-info{padding:9px 10px;border:1px solid #99f6e4;border-radius:9px;background:#f0fdfa;color:#115e59;font-size:11px;line-height:1.45}
      .crew-operation-warning{padding:9px 10px;border:1px solid #f2d085;border-radius:9px;background:#fff8e7;color:#6b4700;font-size:11px;line-height:1.4}
      .crew-operation-empty{padding:12px;border:1px dashed #cbd5e1;border-radius:10px;color:var(--muted);font-size:12px;text-align:center}
      .crew-operation-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.crew-operation-actions .btn{width:auto}
      @media(max-width:760px){.crew-operation-range,.crew-operation-service-grid{grid-template-columns:1fr}.crew-operation-range button,.crew-operation-actions .btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function bogotaDateKey(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addIsoDays(dateText, days) {
    const date = new Date(`${dateText}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function operationIdFromDetails(details) {
    const action = details?.querySelector('form.attendance-map-form')?.getAttribute('action') || '';
    const match = action.match(/\/clientes\/[^/]+\/operaciones\/([^/]+)\/asistencia\/?$/);
    if (!match?.[1]) return '';
    try { return decodeURIComponent(match[1]); } catch (_error) { return match[1]; }
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
      throw new Error(payload?.error || 'No fue posible completar la acción.');
    }
    return payload || {};
  }

  function setStatus(panel, message, error = false) {
    const status = panel.querySelector('[data-crew-operation-status]');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', Boolean(error));
  }

  function currentRange(panel) {
    return {
      from: panel.querySelector('[data-crew-range-from]')?.value || '',
      to: panel.querySelector('[data-crew-range-to]')?.value || ''
    };
  }

  function buildShell(details, operationId) {
    const panel = element('section', 'crew-operation-panel');
    panel.dataset.crewOperationConfig = operationId;

    const heading = element('div', 'crew-operation-title');
    const copy = element('div');
    copy.append(
      element('h4', '', 'Marcación por cuadrilla'),
      element('p', '', 'Aquí habilitas la capacidad de la operación y defines si cada turno será Individual o Cuadrilla. El encargado se marca después en la vista de Asignaciones y es una de las personas incluidas en el total requerido.')
    );
    heading.append(copy);

    const status = element('div', 'crew-operation-status');
    status.dataset.crewOperationStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const capability = element('label', 'crew-operation-capability');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.crewOperationAllowed = 'true';
    checkbox.disabled = true;
    const capabilityCopy = element('span');
    capabilityCopy.append(
      element('strong', '', 'Permitir marcación por cuadrilla'),
      element('small', '', 'El permiso queda guardado para esta operación hasta que lo cambies. Desactivarlo funciona como interruptor de seguridad.')
    );
    capability.append(checkbox, capabilityCopy);

    const today = bogotaDateKey();
    const range = element('div', 'crew-operation-range');
    const fromField = element('div', 'field');
    const fromLabel = element('label', '', 'Turnos desde');
    const from = document.createElement('input');
    from.type = 'date';
    from.value = today;
    from.dataset.crewRangeFrom = 'true';
    fromField.append(fromLabel, from);
    const toField = element('div', 'field');
    const toLabel = element('label', '', 'Turnos hasta');
    const to = document.createElement('input');
    to.type = 'date';
    to.value = addIsoDays(today, DEFAULT_RANGE_DAYS);
    to.dataset.crewRangeTo = 'true';
    toField.append(toLabel, to);
    const reloadButton = element('button', 'btn', 'Actualizar turnos');
    reloadButton.type = 'button';
    reloadButton.dataset.crewReload = 'true';
    range.append(fromField, toField, reloadButton);

    const serviceArea = element('div', 'crew-operation-service');
    serviceArea.dataset.crewServiceArea = 'true';
    serviceArea.appendChild(element('div', 'crew-operation-empty', 'Abre este panel para cargar los turnos de la operación.'));

    panel.append(heading, status, capability, range, serviceArea);
    details.querySelector('form.attendance-map-form')?.insertAdjacentElement('afterend', panel);
    states.set(panel, { operationId, selectedServiceId: null, loading: false, loaded: false });
    return panel;
  }

  function renderCapability(panel, operation, reload) {
    const checkbox = panel.querySelector('[data-crew-operation-allowed]');
    if (!checkbox) return;
    if (!operation) {
      checkbox.checked = false;
      checkbox.disabled = true;
      return;
    }

    checkbox.checked = operation.crewAttendanceAllowed === true;
    checkbox.disabled = operation.attendanceEnabled !== true && operation.crewAttendanceAllowed !== true;
    checkbox.onchange = async () => {
      const desired = checkbox.checked;
      checkbox.disabled = true;
      setStatus(panel, 'Guardando configuración de cuadrilla…');
      try {
        await requestJson(`/admin/operaciones/asistencia/cuadrillas/operaciones/${encodeURIComponent(operation.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ allowed: String(desired) })
        });
        setStatus(panel, desired
          ? 'La operación permite marcación por cuadrilla.'
          : 'La marcación por cuadrilla quedó deshabilitada para esta operación.');
        await reload();
      } catch (error) {
        checkbox.checked = !desired;
        checkbox.disabled = false;
        setStatus(panel, error.message, true);
      }
    };
  }

  function serviceOptionLabel(service) {
    const time = service.startTime ? ` · ${service.startTime}` : '';
    return `${service.serviceDate || 'Sin fecha'}${time} · ${service.operationPointName || 'Operación'}`;
  }

  function leaderName(service) {
    if (!service?.crewLeaderWorkerId) return null;
    return service.assignments?.find((assignment) => assignment.workerId === service.crewLeaderWorkerId)?.fullName || null;
  }

  function renderServiceEditor(panel, operation, services, selectedServiceId, reload) {
    const area = panel.querySelector('[data-crew-service-area]');
    if (!area) return;
    area.replaceChildren();

    const heading = element('div');
    heading.append(
      element('strong', '', 'Servicios / turnos de esta operación'),
      element('div', 'muted', 'Solo aparecen solicitudes del rango seleccionado que pertenecen a esta operación.')
    );
    area.appendChild(heading);

    if (!operation) {
      area.appendChild(element('div', 'crew-operation-empty', 'La operación está inactiva o ya no está disponible para configurar cuadrillas.'));
      return;
    }
    if (!services.length) {
      area.appendChild(element('div', 'crew-operation-empty', 'No hay servicios o turnos de esta operación en el rango seleccionado. Ajusta las fechas si necesitas buscar otro turno.'));
      return;
    }

    const requested = services.find((service) => service.id === selectedServiceId) || services[0];
    states.get(panel).selectedServiceId = requested.id;

    const grid = element('div', 'crew-operation-service-grid');
    const serviceField = element('div', 'field');
    serviceField.appendChild(element('label', '', 'Servicio / turno'));
    const serviceSelect = document.createElement('select');
    services.forEach((service) => {
      const option = document.createElement('option');
      option.value = service.id;
      option.textContent = serviceOptionLabel(service);
      option.selected = service.id === requested.id;
      serviceSelect.appendChild(option);
    });
    serviceField.appendChild(serviceSelect);

    const modeField = element('div', 'field');
    modeField.appendChild(element('label', '', 'Modalidad de marcación'));
    const modeSelect = document.createElement('select');
    [[MODE_INDIVIDUAL, 'Individual'], [MODE_CREW, 'Cuadrilla']].forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = requested.mode === value;
      modeSelect.appendChild(option);
    });
    modeField.appendChild(modeSelect);
    grid.append(serviceField, modeField);

    const currentLeaderName = leaderName(requested);
    const summary = element('div', 'crew-operation-summary');
    summary.textContent = `Personas requeridas: ${requested.requiredWorkers} · Asignadas activas: ${requested.assignments.length} · Encargado: ${currentLeaderName || 'pendiente en Asignaciones'}.`;

    const info = element('div', 'crew-operation-info');
    info.textContent = 'El encargado no es una persona adicional: debe ser una de las personas ya asignadas al turno. Selecciónalo con el check “Encargado de cuadrilla” en Operaciones → Asignaciones.';

    const warning = element('div', 'crew-operation-warning');
    warning.hidden = true;
    const actions = element('div', 'crew-operation-actions');
    const saveButton = element('button', 'btn btn-primary', 'Guardar modalidad del turno');
    saveButton.type = 'button';
    actions.appendChild(saveButton);

    function syncControls() {
      const crew = modeSelect.value === MODE_CREW;
      warning.hidden = true;
      warning.textContent = '';
      let blocked = false;
      if (crew && operation.attendanceEnabled !== true) {
        warning.textContent = 'Primero guarda y habilita Asistencia para esta operación.';
        warning.hidden = false;
        blocked = true;
      } else if (crew && operation.crewAttendanceAllowed !== true) {
        warning.textContent = 'Activa “Permitir marcación por cuadrilla” en esta misma operación.';
        warning.hidden = false;
        blocked = true;
      } else if (crew && requested.assignments.length > 0 && !currentLeaderName) {
        warning.textContent = 'Puedes guardar el modo Cuadrilla ahora. Después marca al encargado desde la misma vista de Asignaciones.';
        warning.hidden = false;
      }
      saveButton.disabled = blocked;
    }

    serviceSelect.addEventListener('change', () => {
      renderServiceEditor(panel, operation, services, serviceSelect.value, reload);
    });
    modeSelect.addEventListener('change', syncControls);
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      setStatus(panel, 'Guardando modalidad del turno…');
      const keepLeaderId = modeSelect.value === MODE_CREW && requested.leaderValid
        ? (requested.crewLeaderWorkerId || '')
        : '';
      try {
        await requestJson(`/admin/operaciones/asistencia/cuadrillas/servicios/${encodeURIComponent(requested.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({
            mode: modeSelect.value,
            crewLeaderWorkerId: keepLeaderId
          })
        });
        setStatus(panel, modeSelect.value === MODE_CREW
          ? (keepLeaderId
              ? 'Turno configurado para Cuadrilla; conserva el encargado seleccionado en Asignaciones.'
              : 'Turno configurado para Cuadrilla. Ahora selecciona el encargado desde Asignaciones.')
          : 'Turno configurado para marcación individual.');
        await reload(requested.id);
      } catch (error) {
        setStatus(panel, error.message, true);
        syncControls();
      }
    });

    area.append(grid, summary, info, warning, actions);
    syncControls();
  }

  async function loadPanel(panel, selectedServiceId = null) {
    const state = states.get(panel);
    if (!state || state.loading) return;
    state.loading = true;
    const reloadButton = panel.querySelector('[data-crew-reload]');
    if (reloadButton) reloadButton.disabled = true;
    setStatus(panel, 'Cargando configuración de esta operación…');
    try {
      const range = currentRange(panel);
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      const configuration = await requestJson(`${CONFIG_PATH}?${params.toString()}`);
      const operation = (configuration.operations || []).find((item) => item.id === state.operationId) || null;
      const services = (configuration.services || []).filter((service) => service.operationPointId === state.operationId);
      const reload = async (nextServiceId = state.selectedServiceId) => loadPanel(panel, nextServiceId);
      renderCapability(panel, operation, reload);
      renderServiceEditor(panel, operation, services, selectedServiceId || state.selectedServiceId, reload);
      state.loaded = true;
      setStatus(panel, operation
        ? 'Configuración de cuadrilla cargada para esta operación.'
        : 'Esta operación no está activa; reactívala para configurar cuadrillas.', !operation);
    } catch (error) {
      setStatus(panel, error.message || 'No fue posible cargar la configuración de cuadrillas.', true);
    } finally {
      state.loading = false;
      if (reloadButton) reloadButton.disabled = false;
    }
  }

  function initializePanel(details) {
    if (details.dataset.crewOperationInstalled === 'true') return;
    const operationId = operationIdFromDetails(details);
    if (!operationId) return;
    details.dataset.crewOperationInstalled = 'true';
    const panel = buildShell(details, operationId);
    panel.querySelector('[data-crew-reload]')?.addEventListener('click', () => loadPanel(panel));
    details.addEventListener('toggle', () => {
      const state = states.get(panel);
      if (details.open && state && !state.loaded) loadPanel(panel);
    });
    if (details.open) loadPanel(panel);
  }

  function initialize() {
    if (window[PANEL_FLAG]) return;
    const details = [...document.querySelectorAll('details.attendance-config')];
    if (!details.length) return;
    window[PANEL_FLAG] = true;
    installStyles();
    details.forEach(initializePanel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
