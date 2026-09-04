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
    title: 'Nómina y tiempo trabajado',
    description: 'Permiso independiente para cortes, conceptos y exportaciones. No activa Operaciones ni Asistencia.',
    summary: 'Nómina y tiempo trabajado'
  };
  const testWorkspacePermission = {
    id: 'test-workspace',
    apiBase: '/admin/operaciones/pruebas/api/users',
    accessSuffix: 'access',
    pendingKey: 'lorren-test-workspace-access-after-create',
    title: 'Entorno de pruebas de asistencia y nómina',
    description: 'Permite usar auxiliares, clientes y operaciones existentes dentro de registros DEV_TEST aislados. No modifica la operación real.',
    summary: 'Entorno de pruebas'
  };
  const PERMISSIONS = canManageTestWorkspace
    ? [payrollPermission, testWorkspacePermission]
    : [payrollPermission];

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

  function renderCapabilityGroups(container, capabilities, effectivePermissions, editableCapabilities = null) {
    container.replaceChildren();
    const effective = new Set(effectivePermissions || []);
    const editable = editableCapabilities ? new Set(editableCapabilities) : null;
    for (const [moduleName, items] of groupCapabilities(capabilities)) {
      if (moduleName === 'Supervisión') continue;
      const group = document.createElement('fieldset');
      group.style.border = '1px solid rgba(148,163,184,.35)';
      group.style.borderRadius = '10px';
      group.style.padding = '10px';
      group.style.margin = '0';
      const legend = document.createElement('legend');
      legend.textContent = moduleName;
      legend.style.fontWeight = '700';
      group.append(legend);
      for (const capability of items) {
        const control = capabilityCheckbox(
          capability,
          effective.has(capability.key),
          editable ? !editable.has(capability.key) : false
        );
        group.append(control.label);
      }
      container.append(group);
    }
  }

  function readCapabilityStates(container, allowed = null) {
    const states = {};
    const allowedSet = allowed ? new Set(allowed) : null;
    container.querySelectorAll('input[data-operational-capability]').forEach((input) => {
      const key = input.dataset.operationalCapability;
      if (!key || (allowedSet && !allowedSet.has(key))) return;
      states[key] = input.checked;
    });
    return states;
  }

  function renderDelegableControls(container, capabilities, selected = []) {
    container.replaceChildren();
    const selectedSet = new Set(selected || []);
    const delegableCapabilities = (capabilities || []).filter((item) => item.key !== 'SUPERVISE_PERMISSIONS');
    for (const [moduleName, items] of groupCapabilities(delegableCapabilities)) {
      if (moduleName === 'Supervisión') continue;
      const group = document.createElement('div');
      group.style.display = 'grid';
      group.style.gap = '4px';
      const heading = document.createElement('small');
      heading.style.fontWeight = '700';
      heading.textContent = moduleName;
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

  function buildOperationalEditorShell(createMode = false) {
    const section = document.createElement('section');
    section.dataset.operationalAccessEditor = 'true';
    section.style.display = 'grid';
    section.style.gap = '12px';
    section.style.marginTop = '12px';
    section.style.padding = '12px';
    section.style.border = '1px solid rgba(148,163,184,.45)';
    section.style.borderRadius = '12px';

    section.append(operationalSectionTitle(
      'Rol operativo y funciones',
      createMode
        ? 'DEV define el rol base y puede habilitar o restringir funciones individuales.'
        : 'El rol aporta una base; los checks permiten ampliar o restringir funciones para este usuario.'
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
      'Funciones que este Supervisor puede delegar',
      'Solo DEV define este techo. El Supervisor nunca puede cambiar roles ni ampliar su propio techo.'
    ));
    const delegationHost = document.createElement('div');
    delegationHost.style.display = 'grid';
    delegationHost.style.gap = '8px';
    delegationBlock.append(delegationHost);

    const status = document.createElement('small');
    status.className = 'hint';

    section.append(roleRow, capabilityHost, delegationBlock, status);
    return { section, roleSelect, capabilityHost, delegationBlock, delegationHost, status };
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

  function applyRoleDefaults(shell, catalog, role, effectivePermissions = null, delegablePermissions = []) {
    const base = role ? roleBasePermissions(catalog.roles, role) : new Set();
    const effective = effectivePermissions ? new Set(effectivePermissions) : base;
    renderCapabilityGroups(shell.capabilityHost, catalog.capabilities, [...effective]);
    shell.capabilityHost.querySelectorAll('input[data-operational-capability]').forEach((input) => {
      input.disabled = !role;
    });
    const supervisor = role === 'SUPERVISOR';
    shell.delegationBlock.style.display = supervisor ? 'grid' : 'none';
    if (supervisor) renderDelegableControls(shell.delegationHost, catalog.capabilities, delegablePermissions);
    else shell.delegationHost.replaceChildren();
  }

  async function initializeOperationalCreateForm(form) {
    if (operationalActorRole !== 'dev' || form.querySelector('[data-operational-access-editor]')) return;
    const catalog = await operationalCatalog();
    const shell = buildOperationalEditorShell(true);
    fillRoleSelect(shell.roleSelect, catalog.roles, null, true);
    applyRoleDefaults(shell, catalog, null);
    permissionHost(form).append(shell.section);

    shell.roleSelect.addEventListener('change', () => {
      applyRoleDefaults(shell, catalog, shell.roleSelect.value || null);
      shell.status.textContent = shell.roleSelect.value
        ? 'Ajusta los checks si este usuario necesita más o menos funciones que el rol base.'
        : 'El usuario quedará sin rol operativo hasta que DEV se lo asigne.';
    });

    form.addEventListener('submit', () => {
      const role = shell.roleSelect.value || null;
      if (!role) {
        sessionStorage.removeItem(OPERATIONAL_PENDING_KEY);
        return;
      }
      sessionStorage.setItem(OPERATIONAL_PENDING_KEY, JSON.stringify({
        role,
        permissions: readCapabilityStates(shell.capabilityHost),
        delegablePermissions: role === 'SUPERVISOR' ? readDelegablePermissions(shell.delegationHost) : []
      }));
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
    const shell = buildOperationalEditorShell(false);
    fillRoleSelect(shell.roleSelect, catalog.roles, access.role || null, true);
    applyRoleDefaults(shell, catalog, access.role || null, access.effectivePermissions || [], access.delegablePermissions || []);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-secondary';
    save.textContent = 'Guardar rol y funciones';
    shell.section.append(save);
    permissionHost(form).append(shell.section);

    shell.roleSelect.addEventListener('change', () => {
      const role = shell.roleSelect.value || null;
      applyRoleDefaults(shell, catalog, role);
      shell.status.textContent = role
        ? 'Se cargó la base del nuevo rol. Revisa los checks antes de guardar.'
        : 'Selecciona un rol para poder guardar esta configuración.';
    });

    save.addEventListener('click', async () => {
      const role = shell.roleSelect.value || null;
      if (!role) {
        shell.status.textContent = 'Selecciona Consulta, Coordinador o Supervisor.';
        return;
      }
      save.disabled = true;
      shell.status.textContent = 'Guardando rol y funciones…';
      try {
        const result = await request(operationalAccessUrl(userId), {
          method: 'POST',
          body: JSON.stringify({
            role,
            permissions: readCapabilityStates(shell.capabilityHost),
            delegablePermissions: role === 'SUPERVISOR' ? readDelegablePermissions(shell.delegationHost) : []
          })
        });
        const next = result.access || {};
        fillRoleSelect(shell.roleSelect, catalog.roles, next.role || role, true);
        applyRoleDefaults(shell, catalog, next.role || role, next.effectivePermissions || [], next.delegablePermissions || []);
        shell.status.textContent = `Rol ${roleLabel(catalog.roles, next.role || role)} guardado.`;
      } catch {
        shell.status.textContent = 'No fue posible guardar el rol operativo.';
      } finally {
        save.disabled = false;
      }
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
      showNotice('Rol operativo y funciones aplicados al usuario creado.');
    } catch {
      showNotice('El usuario se creó, pero no fue posible aplicar su rol operativo.', false);
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
    const visibleCapabilities = capabilities.filter((item) => editableCapabilities.includes(item.key));
    renderCapabilityGroups(capabilityHost, visibleCapabilities, user.effectivePermissions || [], editableCapabilities);
    const status = document.createElement('small');
    status.className = 'hint';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-secondary';
    save.textContent = 'Guardar funciones';
    save.addEventListener('click', async () => {
      save.disabled = true;
      status.textContent = 'Guardando permisos…';
      try {
        await request(operationalAccessUrl(user.userId), {
          method: 'POST',
          body: JSON.stringify({ permissions: readCapabilityStates(capabilityHost, editableCapabilities) })
        });
        status.textContent = 'Funciones actualizadas.';
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
      'Puedes habilitar o restringir únicamente las funciones que DEV autorizó para delegar. Los roles siguen siendo exclusivos de DEV.'
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
      PERMISSIONS.forEach((config) => permissionControl({ form: createForm, createMode: true, config }));
      initializeOperationalCreateForm(createForm).catch(() => {});
    }
    document.querySelectorAll('form[action^="/admin/locations/users/"][action$="/access"]').forEach((form) => {
      initializeEditForm(form).catch(() => {});
    });
    applyPendingCreatePermissions().catch(() => {});
    applyPendingCreateOperationalAccess().catch(() => {});
    initializeSupervisorPanel().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
