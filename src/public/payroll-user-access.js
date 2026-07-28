'use strict';

(() => {
  const API_BASE = '/admin/operaciones/asistencia/nomina/api/users';
  const PENDING_CREATE_KEY = 'lorren-payroll-access-after-create';

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'payroll-user-access',
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || 'payroll_access_failed');
    return payload;
  }

  function forceParentPermissions(form, enabled) {
    if (!enabled) return;
    const dispatch = form.querySelector('input[name="canAccessDispatch"]');
    const attendance = form.querySelector('input[name="canAccessAttendance"]');
    if (dispatch) dispatch.checked = true;
    if (attendance) attendance.checked = true;
  }

  function updatePermissionSummary(form, enabled) {
    const row = form.closest('tr');
    const permissionCell = row?.querySelectorAll('td')?.[2];
    if (!permissionCell) return;
    let label = permissionCell.querySelector('[data-payroll-permission-label]');
    if (enabled && !label) {
      label = document.createElement('small');
      label.dataset.payrollPermissionLabel = 'true';
      label.textContent = 'Nómina y tiempo trabajado';
      permissionCell.appendChild(label);
    } else if (!enabled && label) {
      label.remove();
    }
  }

  function permissionControl({ form, userId = null, initial = false, createMode = false }) {
    const host = form.querySelector('.field.full:has(input[name="canAccessAttendance"])')
      || form.querySelector('.permission-stack')
      || form.querySelector('.grid')
      || form;
    if (host.querySelector('[data-payroll-permission]')) return;

    const label = document.createElement('label');
    label.className = createMode ? 'permission-card' : 'dispatch-row';
    label.dataset.payrollPermission = 'true';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = initial;
    checkbox.setAttribute('aria-label', 'Permitir acceso a Nómina y tiempo trabajado');

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = 'Nómina y tiempo trabajado';
    const small = document.createElement('small');
    small.textContent = 'Cortes semanales, quincenales, conceptos y exportaciones para nómina.';
    text.append(strong, small);
    label.append(checkbox, text);

    const status = document.createElement('span');
    status.className = 'hint';
    status.textContent = initial ? 'Permiso activo.' : 'Permiso desactivado.';

    if (createMode) {
      host.append(label);
      checkbox.addEventListener('change', () => forceParentPermissions(form, checkbox.checked));
      form.addEventListener('submit', () => {
        if (checkbox.checked) sessionStorage.setItem(PENDING_CREATE_KEY, 'true');
        else sessionStorage.removeItem(PENDING_CREATE_KEY);
        forceParentPermissions(form, checkbox.checked);
      });
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.display = 'grid';
    wrapper.style.gap = '4px';
    wrapper.append(label, status);
    host.append(wrapper);
    updatePermissionSummary(form, initial);

    checkbox.addEventListener('change', async () => {
      const requested = checkbox.checked;
      checkbox.disabled = true;
      status.textContent = 'Guardando permiso…';
      forceParentPermissions(form, requested);
      try {
        const payload = await request(`${API_BASE}/${encodeURIComponent(userId)}/access`, {
          method: 'POST',
          body: JSON.stringify({ enabled: requested })
        });
        checkbox.checked = payload.enabled === true;
        status.textContent = checkbox.checked
          ? 'Permiso activo. Operaciones y Asistencia también quedan habilitados.'
          : 'Permiso de Nómina desactivado.';
        updatePermissionSummary(form, checkbox.checked);
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
    try {
      const payload = await request(`${API_BASE}/${encodeURIComponent(userId)}/access`, { method: 'GET' });
      permissionControl({ form, userId, initial: payload.enabled === true });
    } catch {
      // Solo DEV recibe el control. Para otros perfiles la API responde 403 y no se renderiza nada.
    }
  }

  async function applyPendingCreatePermission() {
    if (sessionStorage.getItem(PENDING_CREATE_KEY) !== 'true') return;
    const username = new URLSearchParams(window.location.search).get('username');
    if (!username) return;
    sessionStorage.removeItem(PENDING_CREATE_KEY);
    try {
      await request(`${API_BASE}/by-username/${encodeURIComponent(username)}/access`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true })
      });
      const notice = document.createElement('div');
      notice.className = 'alert alert-success';
      notice.textContent = `Nómina habilitada para ${username}.`;
      document.querySelector('.page')?.prepend(notice);
    } catch {
      const notice = document.createElement('div');
      notice.className = 'alert alert-error';
      notice.textContent = `El usuario ${username} se creó, pero no fue posible activar Nómina.`;
      document.querySelector('.page')?.prepend(notice);
    }
  }

  function initialize() {
    const createForm = document.querySelector('form[action="/admin/users/create"]');
    if (createForm) permissionControl({ form: createForm, createMode: true });
    document.querySelectorAll('form[action^="/admin/locations/users/"][action$="/access"]').forEach((form) => {
      initializeEditForm(form).catch(() => {});
    });
    applyPendingCreatePermission().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
