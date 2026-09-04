'use strict';

(() => {
  const script = document.currentScript;
  const canManageTestWorkspace = script?.dataset?.canManageTestWorkspace === 'true';
  const operationalActorRole = script?.dataset?.operationalActorRole || 'none';
  const canSuperviseOperationalPermissions = script?.dataset?.canSuperviseOperationalPermissions === 'true';
  const OPERATIONAL_PENDING_KEY = 'lorren-operational-access-after-create';
  const OPERATIONAL_API_BASE = '/admin/locations/users';

  const payrollPermission = {
    id: 'payroll',
    apiBase: '/admin/locations/users',
    accessSuffix: 'payroll-access',
    pendingKey: 'lorren-payroll-access-after-create',
    title: 'Asistencia y Gestión de Tiempo',
    description: 'Permiso independiente para cortes, conceptos y exportaciones de Gestión de Tiempo. No activa Operaciones / Despacho ni Asistencia operativa.',
    summary: 'Asistencia y Gestión de Tiempo'
  };
  const testWorkspacePermission = {
    id: 'test-workspace',
    apiBase: '/admin/operaciones/pruebas/api/users',
    accessSuffix: 'access',
    pendingKey: 'lorren-test-workspace-access-after-create',
    title: 'Entorno de pruebas de Asistencia y Gestión de Tiempo',
    description: 'Permite usar auxiliares, clientes y operaciones existentes dentro de registros DEV_TEST aislados. No modifica la operación real.',
    summary: 'Entorno de pruebas'
  };
  const PERMISSIONS = canManageTestWorkspace ? [testWorkspacePermission] : [];

  let operationalCatalogPromise = null;

  function accessUrl(config, userId) {
    return `${config.apiBase}/${encodeURIComponent(userId)}/${config.accessSuffix}`;
  }

  function operationalAccessUrl(userId) {
    return `${OPERATIONAL_API_BASE}/${encodeURIComponent(userId)}/operational-access`;
  }

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
        const payload = await request(accessUrl(config, userId), {
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

  function roleLabel(roles, role) {
    return roles.find((item) => item.key === role)?.label || role || 'Sin rol';
  }

  function roleBasePermissions(roles, role) {
    return new Set(roles.find((item) => item.key === role)?.basePermissions || []);
  }

  function groupCapabilities(capabilities) {
    const groups = new Map();
    for (const capability of capabilities || []) {
      if (!groups.has(capability.module)) groups.set(capability.module, []);
      groups.get(capability.module).push(capability);
    }
    return groups;
  }

  function capabilityCheckbox(capability, checked, disabled = false) {
    const label = document.createElement('label');
    label.className = 'dispatch-row';
    label.style.alignItems = 'flex-start';
    label.style.gap = '8px';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.operationalCapability = capability.key;
    checkbox.checked = checked;
    checkbox.disabled = disabled;
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = capability.label;
    text.append(strong);
    if (capability.sensitive) {
      const small = document.createElement('small');
      small.textContent = 'Acción sensible';
      text.append(small);
    }
    label.append(checkbox, text);
    return { label, checkbox };
  }

  function operationalSectionTitle(text, description = null) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'grid';
    wrapper.style.gap = '3px';
    const strong = document.createElement('strong');
    strong.textContent = text;
    wrapper.append(strong);
    if (description) {
      const small = document.createElement('small');
      small.className = 'hint';
      small.textContent = description;
      wrapper.append(small);
    }
    return wrapper;
  }

  function moduleDefinition(items = []) {
    return items.find((item) => item.moduleAccess === true && item.moduleAccessKey) || null;
  }

  function legacyModuleInput(form, moduleAccessKey) {
    if (moduleAccessKey === 'dispatch') return form.querySelector('input[name="canAccessDispatch"]');
    if (moduleAccessKey === 'attendance') return form.querySelector('input[name="canAccessAttendance"]');
    return null;
  }

  function hideLegacyModuleControl(input) {
    const label = input?.closest('label');
    if (label) label.style.display = 'none';
  }

  function hideLegacyOperationalModuleControls(form) {
    hideLegacyModuleControl(form.querySelector('input[name="canAccessDispatch"]'));
    hideLegacyModuleControl(form.querySelector('input[name="canAccessAttendance"]'));
  }

  function moduleAccessFromLegacy(form) {
    return {
      dispatch: Boolean(form.querySelector('input[name="canAccessDispatch"]')?.checked),
      attendance: Boolean(form.querySelector('input[name="canAccessAttendance"]')?.checked),
      time: false
    };
  }

  function syncLegacyModuleInput(form, key, checked) {
    const input = legacyModuleInput(form, key);
    if (input) input.checked = checked;
  }

  function normalizeModuleAccess(value = {}) {
    const attendance = value.attendance === true;
    return {
      dispatch: value.dispatch === true || attendance,
      attendance,
      time: value.time === true
    };
  }

  function readModuleAccess(shell) {
    const result = { dispatch: false, attendance: false, time: false };
    shell.capabilityHost.querySelectorAll('input[data-operational-module-access]').forEach((input) => {
      const key = input.dataset.operationalModuleAccess;
      if (key) result[key] = input.checked;
    });
    return normalizeModuleAccess(result);
  }

  function readCapabilityStates(shell, catalog, allowed = null) {
    const states = {};
    const allowedSet = allowed ? new Set(allowed) : null;
    shell.capabilityHost.querySelectorAll('input[data-operational-capability]').forEach((input) => {
      const key = input.dataset.operationalCapability;
      if (!key || (allowedSet && !allowedSet.has(key))) return;
      states[key] = input.checked;
    });
    const moduleAccess = readModuleAccess(shell);
    for (const capability of catalog.capabilities || []) {
      if (capability.moduleAccess !== true || !capability.moduleAccessKey) continue;
      states[capability.key] = moduleAccess[capability.moduleAccessKey] === true;
    }
    return states;
  }

  function renderChildCapabilityGroups(container, capabilities, effectivePermissions, editableCapabilities = null, moduleAccess = null) {
    container.replaceChildren();
    const effective = new Set(effectivePermissions || []);
    const editable = editableCapabilities ? new Set(editableCapabilities) : null;
    const roots = normalizeModuleAccess(moduleAccess || { dispatch: true, attendance: true, time: true });
    for (const [moduleName, items] of groupCapabilities(capabilities)) {
      if (moduleName === 'Supervisión') continue;
      const root = moduleDefinition(items);
      if (root && roots[root.moduleAccessKey] !== true) continue;
      const children = items.filter((item) => item.moduleAccess !== true);
      const visible = editable ? children.filter((item) => editable.has(item.key)) : children;
      if (!visible.length) continue;
      const group = document.createElement('fieldset');
      group.style.border = '1px solid rgba(148,163,184,.35)';
      group.style.borderRadius = '10px';
      group.style.padding = '10px';
      group.style.margin = '0';
      const legend = document.createElement('legend');
      legend.textContent = root?.moduleLabel || moduleName;
      legend.style.fontWeight = '700';
      group.append(legend);
      for (const capability of visible) {
        const control = capabilityCheckbox(capability, effective.has(capability.key), false);
        group.append(control.label);
      }
      container.append(group);
    }
  }

  function renderUnifiedModuleGroups(shell, catalog, role, effectivePermissions = [], moduleAccess = {}) {
    const form = shell.form;
    const effective = new Set(effectivePermissions || []);
    const roots = normalizeModuleAccess(moduleAccess);
    shell.capabilityHost.replaceChildren();

    for (const [moduleName, items] of groupCapabilities(catalog.capabilities || [])) {
      if (moduleName === 'Supervisión') continue;
      const root = moduleDefinition(items);
      if (!root) continue;
      const group = document.createElement('fieldset');
      group.style.border = '1px solid rgba(148,163,184,.35)';
      group.style.borderRadius = '10px';
      group.style.padding = '10px';
      group.style.margin = '0';

      const legend = document.createElement('legend');
      legend.textContent = root.moduleLabel || moduleName;
      legend.style.fontWeight = '700';
      group.append(legend);

      const parentLabel = document.createElement('label');
      parentLabel.className = 'dispatch-row';
      parentLabel.style.alignItems = 'flex-start';
      parentLabel.style.gap = '8px';
      const parent = document.createElement('input');
      parent.type = 'checkbox';
      parent.dataset.operationalModuleAccess = root.moduleAccessKey;
      parent.checked = roots[root.moduleAccessKey] === true;
      parent.disabled = !role;
      const parentText = document.createElement('span');
      const parentTitle = document.createElement('strong');
      parentTitle.textContent = `Permitir acceso a ${root.moduleLabel || moduleName}`;
      const parentHint = document.createElement('small');
      parentHint.textContent = 'Al habilitar este módulo se muestran las funciones internas que puedes asignar.';
      parentText.append(parentTitle, parentHint);
      parentLabel.append(parent, parentText);
      group.append(parentLabel);

      const children = document.createElement('div');
      children.dataset.operationalModuleChildren = root.moduleAccessKey;
      children.style.display = 'grid';
      children.style.gap = '5px';
      children.style.marginTop = '8px';
      for (const capability of items.filter((item) => item.moduleAccess !== true)) {
        const control = capabilityCheckbox(capability, effective.has(capability.key), !role || !parent.checked);
        children.append(control.label);
      }
      group.append(children);
      shell.capabilityHost.append(group);

      const legacy = legacyModuleInput(form, root.moduleAccessKey);
      hideLegacyModuleControl(legacy);
      syncLegacyModuleInput(form, root.moduleAccessKey, parent.checked);

      const updateChildren = () => {
        const enabled = Boolean(role) && parent.checked;
        children.hidden = !parent.checked;
        children.querySelectorAll('input[data-operational-capability]').forEach((input) => { input.disabled = !enabled; });
        syncLegacyModuleInput(form, root.moduleAccessKey, parent.checked);
      };

      parent.addEventListener('change', () => {
        if (root.moduleAccessKey === 'attendance' && parent.checked) {
          const dispatch = shell.capabilityHost.querySelector('input[data-operational-module-access="dispatch"]');
          if (dispatch && !dispatch.checked) {
            dispatch.checked = true;
            dispatch.dispatchEvent(new Event('change'));
          }
        }
        if (root.moduleAccessKey === 'dispatch' && !parent.checked) {
          const attendance = shell.capabilityHost.querySelector('input[data-operational-module-access="attendance"]');
          if (attendance?.checked) {
            attendance.checked = false;
            attendance.dispatchEvent(new Event('change'));
          }
        }
        updateChildren();
      });
      updateChildren();
    }
  }

  function renderDelegableControls(container, capabilities, selected = []) {
    container.replaceChildren();
    const selectedSet = new Set(selected || []);
    const delegableCapabilities = (capabilities || []).filter((item) => (
      item.key !== 'SUPERVISE_PERMISSIONS' && item.moduleAccess !== true
    ));
    for (const [moduleName, items] of groupCapabilities(delegableCapabilities)) {
      if (moduleName === 'Supervisión') continue;
      const group = document.createElement('div');
      group.style.display = 'grid';
      group.style.gap = '4px';
      const heading = document.createElement('small');
      heading.style.fontWeight = '700';
      heading.textContent = items[0]?.moduleLabel || moduleName;
      group.append(heading);
      for (const capability of items) {
        const control = capabilityCheckbox(capability, selectedSet.has(capability.key), false);
        control.checkbox.dataset.delegableCapability = capability.key;
        delete control.checkbox.dataset.operationalCapability;
        group.append(control.label);
      }
      container.append(group);
    }
  }

  function readDelegablePermissions(container) {
    return [...container.querySelectorAll('input[data-delegable-capability]:checked')]
      .map((input) => input.dataset.delegableCapability)
      .filter(Boolean);
  }

  async function operationalCatalog() {
    if (!operationalCatalogPromise) {
      operationalCatalogPromise = request(`${OPERATIONAL_API_BASE}/operational-access/catalog`, { method: 'GET' });
    }
    return operationalCatalogPromise;
  }

  function buildOperationalEditorShell(form, createMode = false) {
    const section = document.createElement('section');
    section.dataset.operationalAccessEditor = 'true';
    section.style.display = 'grid';
    section.style.gap = '12px';
    section.style.marginTop = '12px';
    section.style.padding = '12px';
    section.style.border = '1px solid rgba(148,163,184,.45)';
    section.style.borderRadius = '12px';

    section.append(operationalSectionTitle(
      'Rol, módulos y funciones',
      createMode
        ? 'DEV asigna el rol. Después habilita únicamente los módulos que verá el usuario y, dentro de cada uno, sus funciones.'
        : 'Una sola jerarquía controla el acceso al módulo y las funciones que quedan disponibles dentro de él.'
    ));

    const roleRow = document.createElement('label');
    roleRow.style.display = 'grid';
    roleRow.style.gap = '5px';
    const roleTitle = document.createElement('strong');
    roleTitle.textContent = 'Rol operativo';
    const roleSelect = document.createElement('select');
    roleSelect.dataset.operationalRole = 'true';
    roleRow.append(roleTitle, roleSelect);

    const capabilityHost = document.createElement('div');
    capabilityHost.dataset.operationalCapabilities = 'true';
    capabilityHost.style.display = 'grid';
    capabilityHost.style.gap = '8px';

    const delegationBlock = document.createElement('div');
    delegationBlock.dataset.operationalDelegation = 'true';
    delegationBlock.style.display = 'none';
    delegationBlock.style.gap = '8px';
    delegationBlock.append(operationalSectionTitle(
      'Funciones internas que este Supervisor puede delegar',
      'Solo DEV define este techo. El Supervisor no cambia roles ni habilita módulos; únicamente administra funciones internas autorizadas.'
    ));
    const delegationHost = document.createElement('div');
    delegationHost.style.display = 'grid';
    delegationHost.style.gap = '8px';
    delegationBlock.append(delegationHost);

    const status = document.createElement('small');
    status.className = 'hint';

    section.append(roleRow, capabilityHost, delegationBlock, status);
    return { form, section, roleSelect, capabilityHost, delegationBlock, delegationHost, status };
  }

  function fillRoleSelect(select, roles, selected = null, allowEmpty = true) {
    select.replaceChildren();
    if (allowEmpty) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Sin rol operativo asignado';
      select.append(option);
    }
    for (const role of roles || []) {
      const option = document.createElement('option');
      option.value = role.key;
      option.textContent = role.label;
      option.selected = role.key === selected;
      select.append(option);
    }
  }

  function applyRoleDefaults(shell, catalog, role, effectivePermissions = null, delegablePermissions = [], moduleAccess = null) {
    const base = role ? roleBasePermissions(catalog.roles, role) : new Set();
    const effective = effectivePermissions ? new Set(effectivePermissions) : base;
    const roots = moduleAccess || (shell.capabilityHost.children.length ? readModuleAccess(shell) : moduleAccessFromLegacy(shell.form));
    renderUnifiedModuleGroups(shell, catalog, role, [...effective], roots);
    const supervisor = role === 'SUPERVISOR';
    shell.delegationBlock.style.display = supervisor ? 'grid' : 'none';
    if (supervisor) renderDelegableControls(shell.delegationHost, catalog.capabilities, delegablePermissions);
    else shell.delegationHost.replaceChildren();
  }

  function operationalConfig(shell, catalog) {
    const role = shell.roleSelect.value || null;
    if (!role) return null;
    return {
      role,
      moduleAccess: readModuleAccess(shell),
      permissions: readCapabilityStates(shell, catalog),
      delegablePermissions: role === 'SUPERVISOR' ? readDelegablePermissions(shell.delegationHost) : []
    };
  }

  function validateOperationalSelection(event, shell) {
    const moduleAccess = readModuleAccess(shell);
    const hasModule = Object.values(moduleAccess).some(Boolean);
    if (!hasModule || shell.roleSelect.value) return true;
    event?.preventDefault?.();
    shell.status.textContent = 'Selecciona Consulta, Coordinador o Supervisor antes de habilitar un módulo.';
    return false;
  }

  async function initializeOperationalCreateForm(form) {
    if (operationalActorRole !== 'dev' || form.querySelector('[data-operational-access-editor]')) return;
    const catalog = await operationalCatalog();
    const shell = buildOperationalEditorShell(form, true);
    fillRoleSelect(shell.roleSelect, catalog.roles, null, true);
    applyRoleDefaults(shell, catalog, null, null, [], moduleAccessFromLegacy(form));
    permissionHost(form).append(shell.section);

    shell.roleSelect.addEventListener('change', () => {
      const roots = readModuleAccess(shell);
      applyRoleDefaults(shell, catalog, shell.roleSelect.value || null, null, [], roots);
      shell.status.textContent = shell.roleSelect.value
        ? 'Habilita los módulos necesarios y ajusta sus funciones internas.'
        : 'Sin rol no se habilitan módulos operativos para este usuario.';
    });

    form.addEventListener('submit', (event) => {
      if (!validateOperationalSelection(event, shell)) return;
      const config = operationalConfig(shell, catalog);
      if (!config) {
        sessionStorage.removeItem(OPERATIONAL_PENDING_KEY);
        return;
      }
      sessionStorage.setItem(OPERATIONAL_PENDING_KEY, JSON.stringify(config));
    });
  }

  async function initializeOperationalEditForm(form, userId) {
    if (operationalActorRole !== 'dev' || form.querySelector('[data-operational-access-editor]')) return;
    let payload;
    try {
      payload = await request(operationalAccessUrl(userId), { method: 'GET' });
    } catch {
      return;
    }
    const catalog = { roles: payload.roles || [], capabilities: payload.capabilities || [] };
    const access = payload.access || {};
    const shell = buildOperationalEditorShell(form, false);
    const currentModuleAccess = payload.moduleAccess || moduleAccessFromLegacy(form);
    fillRoleSelect(shell.roleSelect, catalog.roles, access.role || null, true);
    applyRoleDefaults(shell, catalog, access.role || null, access.effectivePermissions || [], access.delegablePermissions || [], currentModuleAccess);

    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = 'operationalAccessConfig';
    shell.section.append(hidden);
    permissionHost(form).append(shell.section);

    shell.roleSelect.addEventListener('change', () => {
      const role = shell.roleSelect.value || null;
      const roots = readModuleAccess(shell);
      applyRoleDefaults(shell, catalog, role, null, role === 'SUPERVISOR' ? access.delegablePermissions || [] : [], roots);
      shell.status.textContent = role
        ? 'Se cargó la base del nuevo rol. Revisa módulos y funciones antes de guardar el formulario.'
        : 'Sin rol no se puede habilitar un módulo operativo.';
    });

    form.addEventListener('submit', (event) => {
      if (!validateOperationalSelection(event, shell)) return;
      const config = operationalConfig(shell, catalog);
      hidden.value = config ? JSON.stringify(config) : '';
    });
  }

  async function initializeEditForm(form) {
    const match = form.action.match(/\/users\/([^/]+)\/access$/);
    if (!match) return;
    const userId = decodeURIComponent(match[1]);
    await Promise.all(PERMISSIONS.map(async (config) => {
      try {
        const payload = await request(accessUrl(config, userId), { method: 'GET' });
        permissionControl({ form, userId, initial: payload.enabled === true, config });
      } catch {
        // El control solo se renderiza cuando el actor puede consultar ese permiso.
      }
    }));
    await initializeOperationalEditForm(form, userId);
  }

  function showNotice(text, success = true) {
    const notice = document.createElement('div');
    notice.className = success ? 'alert alert-success' : 'alert alert-error';
    notice.textContent = text;
    document.querySelector('.page')?.prepend(notice);
  }

  async function applyPendingCreatePermissions() {
    const userId = new URLSearchParams(window.location.search).get('userId');
    if (!userId) return;
    for (const config of PERMISSIONS) {
      if (sessionStorage.getItem(config.pendingKey) !== 'true') continue;
      sessionStorage.removeItem(config.pendingKey);
      try {
        await request(accessUrl(config, userId), {
          method: 'POST',
          body: JSON.stringify({ enabled: true })
        });
        showNotice(`${config.title} habilitado para el usuario creado.`);
      } catch {
        showNotice(`El usuario se creó, pero no fue posible activar ${config.title}.`, false);
      }
    }
  }

  async function applyPendingCreateOperationalAccess() {
    if (operationalActorRole !== 'dev') return;
    const userId = new URLSearchParams(window.location.search).get('userId');
    if (!userId) return;
    const raw = sessionStorage.getItem(OPERATIONAL_PENDING_KEY);
    if (!raw) return;
    sessionStorage.removeItem(OPERATIONAL_PENDING_KEY);
    try {
      const config = JSON.parse(raw);
      await request(operationalAccessUrl(userId), {
        method: 'POST',
        body: JSON.stringify(config)
      });
      showNotice('Rol, módulos y funciones aplicados al usuario creado.');
    } catch {
      showNotice('El usuario se creó, pero no fue posible aplicar su configuración operativa.', false);
    }
  }

  function supervisorUserEditor(user, capabilities, editableCapabilities) {
    const details = document.createElement('details');
    details.style.border = '1px solid rgba(148,163,184,.35)';
    details.style.borderRadius = '10px';
    details.style.padding = '8px 10px';
    const summary = document.createElement('summary');
    summary.style.cursor = 'pointer';
    summary.style.fontWeight = '700';
    summary.textContent = `${user.displayName || user.username} · ${user.role === 'COORDINADOR' ? 'Coordinador' : 'Consulta'}`;
    details.append(summary);

    const body = document.createElement('div');
    body.style.display = 'grid';
    body.style.gap = '8px';
    body.style.marginTop = '10px';
    const capabilityHost = document.createElement('div');
    capabilityHost.style.display = 'grid';
    capabilityHost.style.gap = '8px';
    const visibleCapabilities = capabilities.filter((item) => (
      item.moduleAccess !== true
      && editableCapabilities.includes(item.key)
      && (!item.moduleAccessKey || user.moduleAccess?.[item.moduleAccessKey] === true)
    ));
    renderChildCapabilityGroups(capabilityHost, visibleCapabilities, user.effectivePermissions || [], editableCapabilities, user.moduleAccess || {});
    const status = document.createElement('small');
    status.className = 'hint';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-secondary';
    save.textContent = 'Guardar funciones internas';
    save.disabled = !visibleCapabilities.length;
    if (!visibleCapabilities.length) status.textContent = 'DEV no habilitó funciones delegables dentro de los módulos permitidos para este usuario.';
    save.addEventListener('click', async () => {
      save.disabled = true;
      status.textContent = 'Guardando permisos…';
      try {
        const states = {};
        capabilityHost.querySelectorAll('input[data-operational-capability]').forEach((input) => {
          const key = input.dataset.operationalCapability;
          if (key && editableCapabilities.includes(key)) states[key] = input.checked;
        });
        await request(operationalAccessUrl(user.userId), {
          method: 'POST',
          body: JSON.stringify({ permissions: states })
        });
        status.textContent = 'Funciones internas actualizadas.';
      } catch (error) {
        status.textContent = error?.message === 'operational_access_capability_not_delegable'
          ? 'DEV no autorizó delegar una de estas funciones.'
          : 'No fue posible actualizar las funciones.';
      } finally {
        save.disabled = false;
      }
    });
    body.append(capabilityHost, save, status);
    details.append(body);
    return details;
  }

  async function initializeSupervisorPanel() {
    if (!canSuperviseOperationalPermissions || operationalActorRole !== 'supervisor') return;
    const host = document.querySelector('.page') || document.querySelector('main') || document.body;
    if (document.querySelector('[data-operational-supervision-panel]')) return;

    const panel = document.createElement('section');
    panel.dataset.operationalSupervisionPanel = 'true';
    panel.style.display = 'grid';
    panel.style.gap = '10px';
    panel.style.marginBottom = '14px';
    panel.style.padding = '12px';
    panel.style.border = '1px solid rgba(148,163,184,.45)';
    panel.style.borderRadius = '12px';
    panel.append(operationalSectionTitle(
      'Supervisión de funciones',
      'Puedes habilitar o restringir funciones internas que DEV autorizó para delegar, solo dentro de módulos ya habilitados. Los roles y accesos a módulos siguen siendo exclusivos de DEV.'
    ));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-secondary';
    toggle.textContent = 'Administrar permisos del equipo';
    const content = document.createElement('div');
    content.hidden = true;
    content.style.display = 'grid';
    content.style.gap = '8px';
    panel.append(toggle, content);
    host.prepend(panel);

    let loaded = false;
    toggle.addEventListener('click', async () => {
      content.hidden = !content.hidden;
      if (content.hidden || loaded) return;
      content.textContent = 'Cargando usuarios…';
      try {
        const payload = await request(`${OPERATIONAL_API_BASE}/operational-access`, { method: 'GET' });
        content.replaceChildren();
        const users = payload.users || [];
        const editableCapabilities = payload.editableCapabilities || [];
        if (!users.length) {
          const empty = document.createElement('small');
          empty.className = 'hint';
          empty.textContent = 'No hay usuarios con rol Consulta o Coordinador disponibles para delegación.';
          content.append(empty);
        } else {
          users.forEach((user) => content.append(supervisorUserEditor(user, payload.capabilities || [], editableCapabilities)));
        }
        loaded = true;
      } catch {
        content.textContent = 'No fue posible cargar los permisos delegables.';
      }
    });
  }

  function initialize() {
    const createForm = document.querySelector('form[action="/admin/users/create"]');
    if (createForm) {
      if (operationalActorRole === 'dev') {
        PERMISSIONS.forEach((config) => permissionControl({ form: createForm, createMode: true, config }));
        initializeOperationalCreateForm(createForm).catch(() => {});
      } else {
        hideLegacyOperationalModuleControls(createForm);
      }
    }
    document.querySelectorAll('form[action^="/admin/locations/users/"][action$="/access"]').forEach((form) => {
      if (operationalActorRole === 'dev') initializeEditForm(form).catch(() => {});
      else hideLegacyOperationalModuleControls(form);
    });
    applyPendingCreatePermissions().catch(() => {});
    applyPendingCreateOperationalAccess().catch(() => {});
    initializeSupervisorPanel().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
