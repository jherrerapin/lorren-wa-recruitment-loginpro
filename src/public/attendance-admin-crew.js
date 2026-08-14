'use strict';

(() => {
  const PANEL_FLAG = '__lorrenCrewAttendanceOperationPanelsInstalled';
  const CONFIG_PATH = '/admin/operaciones/asistencia/cuadrillas/config';
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
      .crew-operation-title h4{margin:0;color:var(--navy);font-size:15px}.crew-operation-title p{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.45;max-width:760px}
      .crew-operation-status{min-height:18px;font-size:12px;font-weight:800;color:#166534}.crew-operation-status.is-error{color:#b91c1c}
      .crew-operation-capability{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc}
      .crew-operation-capability input{width:18px;height:18px;margin-top:1px;accent-color:var(--teal);flex:0 0 auto}.crew-operation-capability strong{display:block;color:#243342;font-size:13px}.crew-operation-capability small{display:block;margin-top:3px;color:var(--muted);font-size:11px;line-height:1.45}
      .crew-operation-info{padding:10px 11px;border:1px solid #99f6e4;border-radius:10px;background:#f0fdfa;color:#115e59;font-size:11px;line-height:1.5}
      .crew-operation-warning{padding:10px 11px;border:1px solid #f2d085;border-radius:10px;background:#fff8e7;color:#6b4700;font-size:11px;line-height:1.45}
    `;
    document.head.appendChild(style);
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

  function buildShell(details, operationId) {
    const panel = element('section', 'crew-operation-panel');
    panel.dataset.crewOperationConfig = operationId;

    const heading = element('div', 'crew-operation-title');
    heading.append(
      element('h4', '', 'Marcación por cuadrilla'),
      element('p', '', 'Habilita primero esta operación. Las solicitudes que se creen después heredarán la marcación por cuadrilla; no se activa retroactivamente sobre solicitudes antiguas.')
    );

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
      element('small', '', 'Debe quedar habilitado antes de crear la solicitud. Si luego lo desactivas, funciona como interruptor de seguridad sin borrar el historial de las solicitudes ya creadas.')
    );
    capability.append(checkbox, capabilityCopy);

    const info = element('div', 'crew-operation-info');
    info.textContent = 'Después crea la solicitud y asigna normalmente. En Operaciones → Asignaciones, las personas activas de una solicitud elegible mostrarán el check “Encargado de cuadrilla”. El encargado sigue contando dentro del total requerido.';

    const warning = element('div', 'crew-operation-warning');
    warning.dataset.crewOperationWarning = 'true';
    warning.hidden = true;

    panel.append(heading, status, capability, info, warning);
    details.querySelector('form.attendance-map-form')?.insertAdjacentElement('afterend', panel);
    states.set(panel, { operationId, loading: false, loaded: false });
    return panel;
  }

  function renderCapability(panel, operation, reload) {
    const checkbox = panel.querySelector('[data-crew-operation-allowed]');
    const warning = panel.querySelector('[data-crew-operation-warning]');
    if (!checkbox || !warning) return;

    if (!operation) {
      checkbox.checked = false;
      checkbox.disabled = true;
      warning.hidden = false;
      warning.textContent = 'La operación está inactiva o ya no está disponible.';
      return;
    }

    checkbox.checked = operation.crewAttendanceAllowed === true;
    checkbox.disabled = operation.attendanceEnabled !== true && operation.crewAttendanceAllowed !== true;
    warning.hidden = operation.attendanceEnabled === true;
    warning.textContent = operation.attendanceEnabled === true
      ? ''
      : 'Primero guarda y habilita Asistencia para esta operación.';

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
          ? 'Operación habilitada. Las nuevas solicitudes creadas desde ahora podrán usar marcación por cuadrilla.'
          : 'Marcación por cuadrilla deshabilitada como interruptor de seguridad.');
        await reload();
      } catch (error) {
        checkbox.checked = !desired;
        checkbox.disabled = false;
        setStatus(panel, error.message, true);
      }
    };
  }

  async function loadPanel(panel) {
    const state = states.get(panel);
    if (!state || state.loading) return;
    state.loading = true;
    setStatus(panel, 'Cargando configuración de esta operación…');
    try {
      const configuration = await requestJson(CONFIG_PATH);
      const operation = (configuration.operations || []).find((item) => item.id === state.operationId) || null;
      const reload = async () => loadPanel(panel);
      renderCapability(panel, operation, reload);
      state.loaded = true;
      setStatus(panel, operation
        ? 'Configuración de cuadrilla cargada para esta operación.'
        : 'Esta operación no está activa; reactívala para configurar cuadrillas.', !operation);
    } catch (error) {
      setStatus(panel, error.message || 'No fue posible cargar la configuración de cuadrillas.', true);
    } finally {
      state.loading = false;
    }
  }

  function initializePanel(details) {
    if (details.dataset.crewOperationInstalled === 'true') return;
    const operationId = operationIdFromDetails(details);
    if (!operationId) return;
    details.dataset.crewOperationInstalled = 'true';
    const panel = buildShell(details, operationId);
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
