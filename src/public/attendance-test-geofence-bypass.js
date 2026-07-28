'use strict';

(() => {
  const REQUEST_HEADER = 'attendance-test-bypass';

  function endpointFor(form) {
    try {
      const action = new URL(form.action, window.location.origin);
      return `${action.pathname.replace(/\/$/, '')}/prueba-geocerca`;
    } catch {
      return null;
    }
  }

  async function requestStatus(endpoint) {
    const response = await fetch(endpoint, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Requested-With': REQUEST_HEADER }
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload?.ok && payload?.eligible ? payload : null;
  }

  async function updateStatus(endpoint, enabled) {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': REQUEST_HEADER
      },
      body: JSON.stringify({ enabled })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'test_geofence_bypass_update_failed');
    return payload;
  }

  function createControl(form, endpoint, enabled) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field full attendance-test-geofence-bypass';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    checkbox.setAttribute('aria-label', 'Permitir marcación desde cualquier ubicación para pruebas');
    label.append(checkbox, document.createTextNode(' Prueba: permitir marcar desde cualquier ubicación'));

    const status = document.createElement('small');
    status.className = 'muted';
    status.textContent = 'Solo aplica al cliente, operación y auxiliar marcados como prueba.';

    wrapper.append(label, status);
    const actions = form.querySelector('.form-actions');
    if (actions) form.insertBefore(wrapper, actions);
    else form.appendChild(wrapper);

    checkbox.addEventListener('change', async () => {
      const requested = checkbox.checked;
      checkbox.disabled = true;
      status.textContent = 'Guardando…';
      try {
        const payload = await updateStatus(endpoint, requested);
        checkbox.checked = payload.enabled === true;
        status.textContent = checkbox.checked
          ? 'Prueba activa para cliente, operación y auxiliar de prueba.'
          : 'La geocerca vuelve a ser obligatoria.';
      } catch {
        checkbox.checked = !requested;
        status.textContent = 'No fue posible cambiar esta opción.';
      } finally {
        checkbox.disabled = false;
      }
    });
  }

  async function initializeForm(form) {
    if (form.dataset.testGeofenceBypassLoaded === 'true') return;
    form.dataset.testGeofenceBypassLoaded = 'true';
    const endpoint = endpointFor(form);
    if (!endpoint) return;
    const payload = await requestStatus(endpoint).catch(() => null);
    if (!payload) return;
    createControl(form, endpoint, payload.enabled === true);
  }

  function initialize() {
    document.querySelectorAll('form.attendance-map-form').forEach((form) => {
      initializeForm(form).catch(() => {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
