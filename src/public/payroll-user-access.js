'use strict';

(() => {
  const PERMISSIONS = [
    {
      id: 'payroll',
      apiBase: '/admin/operaciones/asistencia/nomina/api/users',
      pendingKey: 'lorren-payroll-access-after-create',
      title: 'Nómina y tiempo trabajado',
      description: 'Permiso independiente para cortes, conceptos y exportaciones. No activa Operaciones ni Asistencia.',
      summary: 'Nómina y tiempo trabajado'
    },
    {
      id: 'test-workspace',
      apiBase: '/admin/operaciones/pruebas/api/users',
      pendingKey: 'lorren-test-workspace-access-after-create',
      title: 'Entorno de pruebas de asistencia y nómina',
      description: 'Permite usar auxiliares, clientes y operaciones existentes dentro de registros DEV_TEST aislados. No modifica la operación real.',
      summary: 'Entorno de pruebas'
    }
  ];

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'feature-user-access',
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || 'feature_access_failed');
    return payload;
  }

  function permissionHost(form) {
    const attendanceInput = form.querySelector('input[name="canAccessAttendance"]');
    return attendanceInput?.closest('.field.full')
      || form.querySelector('.permission-stack')
      || form.querySelector('.grid')
      || form;
  }

  function updatePermissionSummary(form, config, enabled) {
    const row = form.closest('tr');
    const permissionCell = row?.querySelectorAll('td')?.[2];
    if (!permissionCell) return;
    let label = permissionCell.querySelector(`[data-feature-permission-label="${config.id}"]`);
    if (enabled && !label) {
      label = document.createElement('small');
      label.dataset.featurePermissionLabel = config.id;
      label.textContent = config.summary;
      permissionCell.appendChild(label);
    } else if (!enabled && label) {
      label.remove();
    }
  }

  function permissionControl({ form, userId = null, initial = false, createMode = false, config }) {
    const host = permissionHost(form);
    if (host.querySelector(`[data-feature-permission="${config.id}"]`)) return;

    const label = document.createElement('label');
    label.className = createMode ? 'permission-card' : 'dispatch-row';
    label.dataset.featurePermission = config.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = initial;
    checkbox.setAttribute('aria-label', `Permitir acceso a ${config.title}`);

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = config.title;
    const small = document.createElement('small');
    small.textContent = config.description;
    text.append(strong, small);
    label.append(checkbox, text);

    const status = document.createElement('span');
    status.className = 'hint';
    status.textContent = initial ? 'Permiso activo.' : 'Permiso desactivado.';

    if (createMode) {
      host.append(label);
      form.addEventListener('submit', () => {
        if (checkbox.checked) sessionStorage.setItem(config.pendingKey, 'true');
        else sessionStorage.removeItem(config.pendingKey);
      });
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.display = 'grid';
    wrapper.style.gap = '4px';
    wrapper.append(label, status);
    host.append(wrapper);
    updatePermissionSummary(form, config, initial);

    checkbox.addEventListener('change', async () => {
      const requested = checkbox.checked;
      checkbox.disabled = true;
      status.textContent = 'Guardando permiso…';
      try {
        const payload = await request(`${config.apiBase}/${encodeURIComponent(userId)}/access`, {
          method: 'POST',
          body: JSON.stringify({ enabled: requested })
        });
        checkbox.checked = payload.enabled === true;
        status.textContent = checkbox.checked ? 'Permiso activo.' : 'Permiso desactivado.';
        updatePermissionSummary(form, config, checkbox.checked);
      } catch {
        checkbox.checked = !requested;
        status.textContent = 'No fue posible cambiar el permiso.';
      } finally {
        checkbox.disabled = false;
      }
    });
  }

  async function initializeEditForm(form) {
    const match = form.action.match(/\/users\/([^/]+)\/access$/);
    if (!match) return;
    const userId = decodeURIComponent(match[1]);
    await Promise.all(PERMISSIONS.map(async (config) => {
      try {
        const payload = await request(`${config.apiBase}/${encodeURIComponent(userId)}/access`, { method: 'GET' });
        permissionControl({ form, userId, initial: payload.enabled === true, config });
      } catch {
        // El control solo se renderiza cuando DEV puede consultar su estado.
      }
    }));
  }

  function showNotice(text, success = true) {
    const notice = document.createElement('div');
    notice.className = success ? 'alert alert-success' : 'alert alert-error';
    notice.textContent = text;
    document.querySelector('.page')?.prepend(notice);
  }

  async function applyPendingCreatePermissions() {
    const username = new URLSearchParams(window.location.search).get('username');
    if (!username) return;
    for (const config of PERMISSIONS) {
      if (sessionStorage.getItem(config.pendingKey) !== 'true') continue;
      sessionStorage.removeItem(config.pendingKey);
      try {
        await request(`${config.apiBase}/by-username/${encodeURIComponent(username)}/access`, {
          method: 'POST',
          body: JSON.stringify({ enabled: true })
        });
        showNotice(`${config.title} habilitado para ${username}.`);
      } catch {
        showNotice(`El usuario ${username} se creó, pero no fue posible activar ${config.title}.`, false);
      }
    }
  }

  function initialize() {
    const createForm = document.querySelector('form[action="/admin/users/create"]');
    if (createForm) {
      PERMISSIONS.forEach((config) => permissionControl({ form: createForm, createMode: true, config }));
    }
    document.querySelectorAll('form[action^="/admin/locations/users/"][action$="/access"]').forEach((form) => {
      initializeEditForm(form).catch(() => {});
    });
    applyPendingCreatePermissions().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
