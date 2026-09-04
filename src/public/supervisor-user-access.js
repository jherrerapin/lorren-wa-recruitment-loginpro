'use strict';

(() => {
  const API_BASE = '/admin/locations/users';

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'operational-supervisor-access',
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      const error = new Error(payload.error || 'operational_access_failed');
      error.code = payload.error || 'operational_access_failed';
      throw error;
    }
    return payload;
  }

  function roleLabel(role) {
    if (role === 'COORDINADOR') return 'Coordinador';
    if (role === 'CONSULTA') return 'Consulta';
    return role || 'Sin rol';
  }

  function normalizeModuleAccess(value = {}) {
    const attendance = value.attendance === true;
    return {
      dispatch: value.dispatch === true || attendance,
      attendance,
      time: value.time === true
    };
  }

  function rootDefinitions(capabilities, editableModules) {
    const editable = new Set(editableModules || []);
    return (capabilities || []).filter((item) => (
      item.moduleAccess === true
      && item.moduleAccessKey
      && editable.has(item.moduleAccessKey)
    ));
  }

  function functionDefinitions(capabilities, editableCapabilities, moduleKey) {
    const editable = new Set(editableCapabilities || []);
    return (capabilities || []).filter((item) => (
      item.moduleAccess !== true
      && item.moduleAccessKey === moduleKey
      && editable.has(item.key)
    ));
  }

  function functionControl(definition, checked) {
    const label = document.createElement('label');
    label.className = 'supervisor-function';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.operationalCapability = definition.key;

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = definition.label;
    text.append(strong);
    if (definition.sensitive) {
      const small = document.createElement('small');
      small.textContent = 'Acción sensible autorizada por DEV';
      text.append(small);
    }

    label.append(input, text);
    return { label, input };
  }

  function moduleControl({ root, functions, moduleAccess, effectivePermissions }) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'supervisor-module';
    fieldset.dataset.supervisorModule = root.moduleAccessKey;

    const title = document.createElement('label');
    title.className = 'supervisor-module-title';

    const rootInput = document.createElement('input');
    rootInput.type = 'checkbox';
    rootInput.checked = moduleAccess[root.moduleAccessKey] === true;
    rootInput.dataset.supervisorModuleAccess = root.moduleAccessKey;
    rootInput.setAttribute('aria-label', `Permitir acceso a ${root.moduleLabel || root.module}`);

    const titleText = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = root.moduleLabel || root.module;
    const small = document.createElement('small');
    small.textContent = 'Activa o desactiva la disponibilidad completa de este módulo para el usuario.';
    titleText.append(strong, small);
    title.append(rootInput, titleText);
    fieldset.append(title);

    const children = document.createElement('div');
    children.className = 'supervisor-module-functions';
    const effective = new Set(effectivePermissions || []);
    for (const definition of functions) {
      const control = functionControl(definition, effective.has(definition.key));
      children.append(control.label);
    }
    if (!functions.length) {
      const empty = document.createElement('small');
      empty.className = 'hint';
      empty.textContent = 'DEV no delegó funciones internas adicionales de este módulo.';
      children.append(empty);
    }
    fieldset.append(children);

    const updateChildren = () => {
      const enabled = rootInput.checked;
      children.hidden = !enabled;
      children.querySelectorAll('input[data-operational-capability]').forEach((input) => {
        input.disabled = !enabled;
      });
    };
    rootInput.addEventListener('change', updateChildren);
    updateChildren();

    return { fieldset, rootInput };
  }

  function readModuleAccess(container, previous = {}) {
    const next = normalizeModuleAccess(previous);
    container.querySelectorAll('input[data-supervisor-module-access]').forEach((input) => {
      const key = input.dataset.supervisorModuleAccess;
      if (key) next[key] = input.checked;
    });
    return normalizeModuleAccess(next);
  }

  function readPermissions(container, editableCapabilities) {
    const editable = new Set(editableCapabilities || []);
    const states = {};
    container.querySelectorAll('input[data-operational-capability]').forEach((input) => {
      const key = input.dataset.operationalCapability;
      if (key && editable.has(key)) states[key] = input.checked;
    });
    return states;
  }

  function applyReturnedModules(container, moduleAccess) {
    const normalized = normalizeModuleAccess(moduleAccess);
    container.querySelectorAll('input[data-supervisor-module-access]').forEach((input) => {
      const key = input.dataset.supervisorModuleAccess;
      if (!key) return;
      input.checked = normalized[key] === true;
      input.dispatchEvent(new Event('change'));
    });
  }

  function enforceModuleDependency(container, changedInput) {
    const key = changedInput.dataset.supervisorModuleAccess;
    if (key === 'attendance' && changedInput.checked) {
      const dispatch = container.querySelector('input[data-supervisor-module-access="dispatch"]');
      if (dispatch && !dispatch.checked) {
        dispatch.checked = true;
        dispatch.dispatchEvent(new Event('change'));
      }
    }
    if (key === 'dispatch' && !changedInput.checked) {
      const attendance = container.querySelector('input[data-supervisor-module-access="attendance"]');
      if (attendance?.checked) {
        attendance.checked = false;
        attendance.dispatchEvent(new Event('change'));
      }
    }
  }

  function errorMessage(code) {
    if (code === 'operational_module_access_not_delegable') return 'No tienes autorización para cambiar uno de esos módulos.';
    if (code === 'operational_access_capability_not_delegable') return 'DEV no autorizó una de las funciones seleccionadas.';
    if (code === 'operational_access_self_forbidden') return 'No puedes modificar tus propios permisos.';
    if (code === 'operational_access_supervisor_target_forbidden') return 'Solo DEV puede modificar otro Supervisor.';
    return 'No fue posible guardar los permisos operativos.';
  }

  function userEditor(user, payload) {
    const details = document.createElement('details');
    details.className = 'supervisor-user';

    const summary = document.createElement('summary');
    summary.textContent = `${user.displayName || user.username} · ${roleLabel(user.role)}`;
    details.append(summary);

    const body = document.createElement('div');
    body.className = 'supervisor-user-body';
    const moduleAccess = normalizeModuleAccess(user.moduleAccess || {});
    const roots = rootDefinitions(payload.capabilities, payload.editableModules);

    for (const root of roots) {
      const functions = functionDefinitions(payload.capabilities, payload.editableCapabilities, root.moduleAccessKey);
      const control = moduleControl({
        root,
        functions,
        moduleAccess,
        effectivePermissions: user.effectivePermissions || []
      });
      control.rootInput.addEventListener('change', () => enforceModuleDependency(body, control.rootInput));
      body.append(control.fieldset);
    }

    const actions = document.createElement('div');
    actions.className = 'supervisor-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = 'Guardar módulos y funciones';
    save.disabled = roots.length === 0 && !(payload.editableCapabilities || []).length;
    const status = document.createElement('small');
    status.className = 'hint';
    if (save.disabled) status.textContent = 'DEV no habilitó módulos o funciones para delegar.';
    actions.append(save, status);
    body.append(actions);

    save.addEventListener('click', async () => {
      save.disabled = true;
      status.className = 'hint';
      status.textContent = 'Guardando permisos…';
      try {
        const nextModules = readModuleAccess(body, user.moduleAccess || {});
        const permissions = readPermissions(body, payload.editableCapabilities);
        const result = await request(`${API_BASE}/${encodeURIComponent(user.userId)}/operational-access`, {
          method: 'POST',
          body: JSON.stringify({ moduleAccess: nextModules, permissions })
        });
        user.moduleAccess = normalizeModuleAccess(result.moduleAccess || nextModules);
        user.effectivePermissions = result.access?.effectivePermissions || user.effectivePermissions || [];
        applyReturnedModules(body, user.moduleAccess);
        status.className = 'hint status-success';
        status.textContent = 'Módulos y funciones actualizados.';
      } catch (error) {
        status.className = 'hint status-error';
        status.textContent = errorMessage(error?.code);
      } finally {
        save.disabled = false;
      }
    });

    details.append(body);
    return details;
  }

  async function initialize() {
    const host = document.querySelector('[data-supervisor-users-list]');
    if (!host) return;
    try {
      const payload = await request(`${API_BASE}/operational-access`, { method: 'GET' });
      host.replaceChildren();
      const users = payload.users || [];
      if (!users.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No hay usuarios Consulta o Coordinador disponibles para administrar.';
        host.append(empty);
        return;
      }
      users.forEach((user) => host.append(userEditor(user, payload)));
    } catch {
      host.replaceChildren();
      const error = document.createElement('div');
      error.className = 'empty status-error';
      error.textContent = 'No fue posible cargar los permisos de usuarios.';
      host.append(error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
