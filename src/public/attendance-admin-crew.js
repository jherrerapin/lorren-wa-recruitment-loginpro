'use strict';

(() => {
  const PANEL_FLAG = '__lorrenCrewAttendancePanelInstalled';
  const CONFIG_PATH = '/admin/operaciones/asistencia/cuadrillas/config';
  const MODE_INDIVIDUAL = 'INDIVIDUAL';
  const MODE_CREW = 'CREW';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function installStyles() {
    if (document.querySelector('style[data-crew-attendance-styles]')) return;
    const style = document.createElement('style');
    style.dataset.crewAttendanceStyles = 'true';
    style.textContent = `
      .crew-attendance-panel{background:#fff;border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow-sm);overflow:visible}
      .crew-attendance-panel>summary{cursor:pointer;list-style:none;padding:13px 16px;color:var(--navy);font-weight:900;display:flex;align-items:center;justify-content:space-between;gap:12px}
      .crew-attendance-panel>summary::-webkit-details-marker{display:none}
      .crew-attendance-panel>summary::after{content:'▾';color:var(--muted)}.crew-attendance-panel[open]>summary::after{content:'▴'}
      .crew-attendance-body{border-top:1px solid #e5eaf0;padding:14px 16px;display:grid;gap:13px}
      .crew-attendance-intro{margin:0;padding:10px 12px;border:1px solid #bfdbfe;border-radius:11px;background:#eff6ff;color:#1e40af;font-size:12px;line-height:1.45}
      .crew-attendance-status{min-height:18px;font-size:12px;font-weight:800;color:#166534}.crew-attendance-status.is-error{color:#b91c1c}
      .crew-attendance-grid{display:grid;grid-template-columns:minmax(300px,.9fr) minmax(360px,1.1fr);gap:12px;align-items:start}
      .crew-attendance-section{border:1px solid #e5eaf0;border-radius:13px;background:#fafcfd;overflow:hidden;min-width:0}
      .crew-attendance-head{padding:11px 12px;border-bottom:1px solid #e5eaf0}.crew-attendance-head strong{display:block;color:var(--navy);font-size:13px}.crew-attendance-head span{display:block;margin-top:2px;color:var(--muted);font-size:11px;line-height:1.4}
      .crew-attendance-list{display:grid;gap:7px;padding:9px;max-height:360px;overflow:auto}
      .crew-operation-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px;border:1px solid #e5eaf0;border-radius:10px;background:#fff}
      .crew-operation-row strong,.crew-service-summary strong{display:block;color:var(--navy);font-size:12px}.crew-operation-row small,.crew-service-summary small{display:block;margin-top:2px;color:var(--muted);font-size:10px;line-height:1.35}
      .crew-operation-toggle{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:800;color:#334155;white-space:nowrap}.crew-operation-toggle input{width:16px;height:16px;accent-color:var(--teal)}
      .crew-attendance-form{display:grid;gap:9px;padding:10px}.crew-attendance-form .field{gap:4px}.crew-attendance-form select{width:100%}
      .crew-service-summary{padding:9px;border:1px solid #dbeafe;border-radius:10px;background:#fff}
      .crew-attendance-warning{padding:8px 9px;border:1px solid #f2d085;border-radius:9px;background:#fff8e7;color:#6b4700;font-size:11px;line-height:1.4}
      .crew-attendance-empty{padding:14px;color:var(--muted);font-size:12px;text-align:center}
      .crew-attendance-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.crew-attendance-actions .btn{width:auto}
      @media(max-width:900px){.crew-attendance-grid{grid-template-columns:1fr}.crew-attendance-list{max-height:290px}}
      @media(max-width:620px){.crew-operation-row{grid-template-columns:1fr}.crew-operation-toggle{white-space:normal}.crew-attendance-actions .btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function currentRange() {
    return {
      from: document.querySelector('input[name="from"]')?.value || '',
      to: document.querySelector('input[name="to"]')?.value || ''
    };
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
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
    const status = panel.querySelector('[data-crew-status]');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', Boolean(error));
  }

  function operationRows(panel, configuration, reload) {
    const list = panel.querySelector('[data-crew-operation-list]');
    list.replaceChildren();
    if (!configuration.operations?.length) {
      list.appendChild(element('div', 'crew-attendance-empty', 'No hay operaciones activas para configurar.'));
      return;
    }

    configuration.operations.forEach((operation) => {
      const row = element('div', 'crew-operation-row');
      const copy = element('div');
      copy.appendChild(element('strong', '', `${operation.clientName} · ${operation.name}`));
      const attendanceText = operation.attendanceEnabled
        ? 'Asistencia habilitada'
        : 'Asistencia deshabilitada';
      copy.appendChild(element('small', '', `${operation.cityName || 'Sin ciudad'} · ${attendanceText}`));
      if (!operation.attendanceEnabled) {
        copy.appendChild(element('small', '', operation.crewAttendanceAllowed
          ? 'Cuadrilla está pausada por el estado de Asistencia. Puedes deshabilitarla aquí.'
          : 'Activa Asistencia en esta operación antes de permitir cuadrillas.'));
      }

      const label = element('label', 'crew-operation-toggle');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = operation.crewAttendanceAllowed === true;
      checkbox.disabled = operation.attendanceEnabled !== true && operation.crewAttendanceAllowed !== true;
      const labelText = element('span', '', 'Permitir marcación por cuadrilla');
      label.append(checkbox, labelText);
      checkbox.addEventListener('change', async () => {
        const desired = checkbox.checked;
        checkbox.disabled = true;
        setStatus(panel, 'Guardando configuración de la operación…');
        try {
          await requestJson(`/admin/operaciones/asistencia/cuadrillas/operaciones/${encodeURIComponent(operation.id)}`, {
            method: 'POST',
            body: new URLSearchParams({ allowed: String(desired) })
          });
          setStatus(panel, desired
            ? 'La operación permite marcación por cuadrilla.'
            : 'La marcación por cuadrilla quedó deshabilitada para la operación.');
          await reload();
        } catch (error) {
          checkbox.checked = !desired;
          checkbox.disabled = false;
          setStatus(panel, error.message, true);
        }
      });
      row.append(copy, label);
      list.appendChild(row);
    });
  }

  function serviceOptionLabel(service) {
    const time = service.startTime ? ` · ${service.startTime}` : '';
    return `${service.serviceDate || 'Sin fecha'}${time} · ${service.clientName} · ${service.operationPointName}`;
  }

  function serviceEditor(panel, configuration, selectedServiceId, reload) {
    const form = panel.querySelector('[data-crew-service-form]');
    form.replaceChildren();
    const services = Array.isArray(configuration.services) ? configuration.services : [];
    if (!services.length) {
      form.appendChild(element('div', 'crew-attendance-empty', 'No hay servicios en el rango de fechas seleccionado.'));
      return null;
    }

    const requested = services.find((service) => service.id === selectedServiceId) || services[0];
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

    const summary = element('div', 'crew-service-summary');
    summary.appendChild(element('strong', '', `${requested.clientName} · ${requested.operationPointName}`));
    summary.appendChild(element('small', '', `Requeridos: ${requested.requiredWorkers} · Asignados activos: ${requested.assignments.length}`));
    summary.appendChild(element('small', '', requested.crewAvailable
      ? 'La operación está disponible para cuadrilla.'
      : 'La operación no está habilitada actualmente para cuadrilla.'));

    const modeField = element('div', 'field');
    modeField.appendChild(element('label', '', 'Modalidad de marcación del servicio'));
    const modeSelect = document.createElement('select');
    [[MODE_INDIVIDUAL, 'Individual'], [MODE_CREW, 'Cuadrilla']].forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = requested.mode === value;
      modeSelect.appendChild(option);
    });
    modeField.appendChild(modeSelect);

    const leaderField = element('div', 'field');
    leaderField.appendChild(element('label', '', 'Responsable de la cuadrilla'));
    const leaderSelect = document.createElement('select');
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = requested.assignments.length ? 'Selecciona un auxiliar asignado' : 'Pendiente hasta asignar auxiliares';
    leaderSelect.appendChild(emptyOption);
    requested.assignments.forEach((assignment) => {
      const option = document.createElement('option');
      option.value = assignment.workerId;
      option.textContent = assignment.fullName;
      option.selected = requested.crewLeaderWorkerId === assignment.workerId;
      leaderSelect.appendChild(option);
    });
    leaderField.appendChild(leaderSelect);

    const warning = element('div', 'crew-attendance-warning');
    warning.hidden = true;
    const actions = element('div', 'crew-attendance-actions');
    const saveButton = element('button', 'btn btn-primary', 'Guardar modalidad');
    saveButton.type = 'button';
    actions.appendChild(saveButton);

    function syncControls() {
      const crew = modeSelect.value === MODE_CREW;
      leaderField.hidden = !crew;
      warning.hidden = true;
      warning.textContent = '';
      let blocked = false;
      if (crew && !requested.crewAvailable) {
        warning.textContent = 'Primero habilita Asistencia y “Permitir marcación por cuadrilla” en la operación.';
        warning.hidden = false;
        blocked = true;
      } else if (crew && requested.assignments.length > 0 && !leaderSelect.value) {
        warning.textContent = requested.crewLeaderWorkerId && !requested.leaderValid
          ? 'El responsable guardado ya no tiene una asignación activa. Selecciona otro auxiliar.'
          : 'Selecciona el responsable entre los auxiliares asignados a este servicio.';
        warning.hidden = false;
        blocked = true;
      } else if (crew && requested.assignments.length === 0) {
        warning.textContent = 'Puedes preparar el servicio como Cuadrilla. Cuando asignes auxiliares, vuelve aquí para definir el responsable antes de marcar.';
        warning.hidden = false;
      }
      saveButton.disabled = blocked;
    }

    serviceSelect.addEventListener('change', () => serviceEditor(panel, configuration, serviceSelect.value, reload));
    modeSelect.addEventListener('change', syncControls);
    leaderSelect.addEventListener('change', syncControls);
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      setStatus(panel, 'Guardando modalidad del servicio…');
      try {
        await requestJson(`/admin/operaciones/asistencia/cuadrillas/servicios/${encodeURIComponent(requested.id)}`, {
          method: 'POST',
          body: new URLSearchParams({
            mode: modeSelect.value,
            crewLeaderWorkerId: modeSelect.value === MODE_CREW ? leaderSelect.value : ''
          })
        });
        setStatus(panel, modeSelect.value === MODE_CREW
          ? 'Servicio configurado para marcación por cuadrilla.'
          : 'Servicio configurado para marcación individual.');
        await reload(requested.id);
      } catch (error) {
        setStatus(panel, error.message, true);
        syncControls();
      }
    });

    form.append(serviceField, summary, modeField, leaderField, warning, actions);
    syncControls();
    return requested.id;
  }

  function buildPanel() {
    const panel = document.createElement('details');
    panel.className = 'crew-attendance-panel';
    panel.dataset.crewAttendancePanel = 'true';

    const summary = document.createElement('summary');
    const titleWrap = element('span');
    titleWrap.appendChild(element('strong', '', 'Marcación por cuadrillas'));
    titleWrap.appendChild(element('small', '', ' · Configuración'));
    summary.appendChild(titleWrap);

    const body = element('div', 'crew-attendance-body');
    body.appendChild(element('p', 'crew-attendance-intro', 'Esta fase solo define qué operaciones permiten cuadrillas, qué servicios usarán esa modalidad y quién será el responsable. Bluetooth y la marcación grupal se habilitarán en una fase posterior; aquí no se generan marcaciones.'));
    const status = element('div', 'crew-attendance-status');
    status.dataset.crewStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    body.appendChild(status);

    const grid = element('div', 'crew-attendance-grid');
    const operationSection = element('section', 'crew-attendance-section');
    const operationHead = element('div', 'crew-attendance-head');
    operationHead.appendChild(element('strong', '', '1. Capacidad por operación'));
    operationHead.appendChild(element('span', '', 'El check queda persistido hasta que se cambie. Desactivarlo funciona como interruptor de seguridad para futuras marcaciones por cuadrilla.'));
    const operationList = element('div', 'crew-attendance-list');
    operationList.dataset.crewOperationList = 'true';
    operationSection.append(operationHead, operationList);

    const serviceSection = element('section', 'crew-attendance-section');
    const serviceHead = element('div', 'crew-attendance-head');
    serviceHead.appendChild(element('strong', '', '2. Modalidad por servicio / turno'));
    serviceHead.appendChild(element('span', '', 'Individual o Cuadrilla se decide por cada servicio. El responsable nunca queda asignado para siempre a la persona.'));
    const serviceForm = element('div', 'crew-attendance-form');
    serviceForm.dataset.crewServiceForm = 'true';
    serviceSection.append(serviceHead, serviceForm);
    grid.append(operationSection, serviceSection);
    body.appendChild(grid);
    panel.append(summary, body);
    return panel;
  }

  function initialize() {
    if (window[PANEL_FLAG]) return;
    const page = document.querySelector('main.attendance-page');
    const filterCard = page?.querySelector('.filter-card');
    if (!page || !filterCard) return;
    window[PANEL_FLAG] = true;
    installStyles();
    const panel = buildPanel();
    filterCard.insertAdjacentElement('afterend', panel);
    let loaded = false;
    let selectedServiceId = null;

    async function reload(preferredServiceId = selectedServiceId) {
      const range = currentRange();
      const query = new URLSearchParams(range);
      setStatus(panel, 'Cargando configuración de cuadrillas…');
      try {
        const configuration = await requestJson(`${CONFIG_PATH}?${query.toString()}`);
        operationRows(panel, configuration, reload);
        selectedServiceId = serviceEditor(panel, configuration, preferredServiceId, reload);
        setStatus(panel, `Configuración cargada para ${configuration.range?.from || range.from} a ${configuration.range?.to || range.to}.`);
        loaded = true;
      } catch (error) {
        setStatus(panel, error.message, true);
      }
    }

    panel.addEventListener('toggle', () => {
      if (panel.open && !loaded) reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
