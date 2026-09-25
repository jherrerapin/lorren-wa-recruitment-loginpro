'use strict';

(() => {
  const script = document.currentScript;
  const canManageTestWorkspace = script?.dataset?.canManageTestWorkspace === 'true';
  const operationalActorRole = script?.dataset?.operationalActorRole || 'none';
  const OPERATIONAL_PENDING_KEY = 'lorren-operational-access-after-create';
  const OPERATIONAL_API_BASE = '/admin/locations/users';
  const OPERATIONAL_CITIES_URL = '/admin/locations/api/cities';

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
  let operationalCitiesPromise = null;

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

  async function loadOperationalCities() {
    if (!operationalCitiesPromise) {
      operationalCitiesPromise = fetch(OPERATIONAL_CITIES_URL, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'feature-user-access' }
      }).then(async (response) => {
        const payload = await response.json().catch(() => []);
        if (!response.ok || !Array.isArray(payload)) throw new Error('operational_cities_failed');
        return payload;
      });
    }
    return operationalCitiesPromise;
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
    if (!label) return;
    label.hidden = true;
    label.style.setProperty('display', 'none', 'important');
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

  function readCapabilityStates(shell, catalog) {
    const states = {};
    shell.capabilityHost.querySelectorAll('input[data-operational-capability]').forEach((input) => {
      const key = input.dataset.operationalCapability;
      if (key) states[key] = input.checked;
    });
    const moduleAccess = readModuleAccess(shell);
    for (const capability of catalog.capabilities || []) {
      if (capability.moduleAccess !== true || !capability.moduleAccessKey) continue;
      states[capability.key] = moduleAccess[capability.moduleAccessKey] === true;
    }
    return states;
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
      for (const capability of items.filter((item) => item.moduleAccess !== true && item.supervisorOnly !== true)) {
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

  async function operationalCatalog() {
    if (!operationalCatalogPromise) {
      operationalCatalogPromise = Promise.all([
        request(`${OPERATIONAL_API_BASE}/operational-access/catalog`, { method: 'GET' }),
        loadOperationalCities()
      ]).then(([catalog, operationalCities]) => ({ ...catalog, operationalCities }));
    }
    return operationalCatalogPromise;
  }

  function renderOperationalCityScope(shell, cities = [], selectedIds = null) {
    shell.cityHost.replaceChildren();
    shell.cityHost.append(operationalSectionTitle(
      'Ciudades operativas',
      'Este alcance limita los clientes, solicitudes y auxiliares que el usuario puede gestionar en Operaciones.'
    ));

    const allLabel = document.createElement('label');
    allLabel.className = 'dispatch-row';
    const allInput = document.createElement('input');
    allInput.type = 'checkbox';
    allInput.dataset.operationalAllCities = 'true';
    allInput.checked = selectedIds === null;
    const allText = document.createElement('span');
    const allStrong = document.createElement('strong');
    allStrong.textContent = 'Todas las ciudades operativas';
    const allHint = document.createElement('small');
    allHint.textContent = 'Sin restricción territorial. Las ciudades nuevas también quedarán disponibles.';
    allText.append(allStrong, allHint);
    allLabel.append(allInput, allText);
    shell.cityHost.append(allLabel);

    const cityGrid = document.createElement('div');
    cityGrid.style.display = 'grid';
    cityGrid.style.gridTemplateColumns = 'repeat(auto-fit,minmax(160px,1fr))';
    cityGrid.style.gap = '6px 12px';
    const selected = selectedIds === null ? null : new Set(Array.isArray(selectedIds) ? selectedIds : []);
    for (const city of cities) {
      const label = document.createElement('label');
      label.className = 'dispatch-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.operationalCityId = city.id;
      input.checked = selected === null || selected.has(city.id);
      const text = document.createElement('span');
      text.textContent = city.name;
      label.append(input, text);
      cityGrid.append(label);
    }
    shell.cityHost.append(cityGrid);

    const sync = () => {
      const unrestricted = allInput.checked;
      cityGrid.querySelectorAll('input[data-operational-city-id]').forEach((input) => {
        input.disabled = unrestricted;
        if (unrestricted) input.checked = true;
      });
    };
    allInput.addEventListener('change', sync);
    sync();
  }

  function readOperationalCityIds(shell) {
    if (shell.cityHost.querySelector('input[data-operational-all-cities]')?.checked) return null;
    return [...shell.cityHost.querySelectorAll('input[data-operational-city-id]:checked')]
      .map((input) => input.dataset.operationalCityId)
      .filter(Boolean);
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
      'Rol, módulos, ciudades y funciones',
      createMode
        ? 'DEV asigna el rol, el alcance territorial y los módulos que verá el usuario.'
        : 'DEV administra el rol, el alcance territorial, los módulos y las funciones del usuario.'
    ));

    const roleRow = document.createElement('label');
    roleRow.style.display = 'grid';
    roleRow.style.gap = '5px';
    const roleTitle = document.createElement('strong');
    roleTitle.textContent = 'Rol operativo';
    const roleSelect = document.createElement('select');
    roleSelect.dataset.operationalRole = 'true';
    roleRow.append(roleTitle, roleSelect);

    const cityHost = document.createElement('div');
    cityHost.dataset.operationalCities = 'true';
    cityHost.style.display = 'grid';
    cityHost.style.gap = '8px';

    const capabilityHost = document.createElement('div');
    capabilityHost.dataset.operationalCapabilities = 'true';
    capabilityHost.style.display = 'grid';
    capabilityHost.style.gap = '8px';

    const status = document.createElement('small');
    status.className = 'hint';

    section.append(roleRow, cityHost, capabilityHost, status);
    return { form, section, roleSelect, cityHost, capabilityHost, status };
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

  function applyRoleDefaults(shell, catalog, role, effectivePermissions = null, moduleAccess = null) {
    const base = role ? roleBasePermissions(catalog.roles, role) : new Set();
    const effective = effectivePermissions ? new Set(effectivePermissions) : base;
    const roots = moduleAccess || (shell.capabilityHost.children.length ? readModuleAccess(shell) : moduleAccessFromLegacy(shell.form));
    renderUnifiedModuleGroups(shell, catalog, role, [...effective], roots);
  }

  function operationalConfig(shell, catalog) {
    const role = shell.roleSelect.value || null;
    if (!role) return null;
    return {
      role,
      moduleAccess: readModuleAccess(shell),
      permissions: readCapabilityStates(shell, catalog),
      delegablePermissions: [],
      operationalCityIds: readOperationalCityIds(shell)
    };
  }

  function validateOperationalSelection(event, shell) {
    const moduleAccess = readModuleAccess(shell);
    const hasModule = Object.values(moduleAccess).some(Boolean);
    if (!hasModule || shell.roleSelect.value) return true;
    event?.preventDefault?.();
    shell.status.textContent = 'Selecciona Consulta o Supervisor antes de habilitar un módulo.';
    return false;
  }

  async function initializeOperationalCreateForm(form) {
    if (operationalActorRole !== 'dev' || form.querySelector('[data-operational-access-editor]')) return;
    const catalog = await operationalCatalog();
    const shell = buildOperationalEditorShell(form, true);
    fillRoleSelect(shell.roleSelect, catalog.roles, null, true);
    renderOperationalCityScope(shell, catalog.operationalCities || [], null);
    applyRoleDefaults(shell, catalog, null, null, moduleAccessFromLegacy(form));
    permissionHost(form).append(shell.section);

    shell.roleSelect.addEventListener('change', () => {
      const roots = readModuleAccess(shell);
      applyRoleDefaults(shell, catalog, shell.roleSelect.value || null, null, roots);
      shell.status.textContent = shell.roleSelect.value
        ? 'Configura las ciudades, los módulos y las funciones necesarias.'
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
    const catalogBase = await operationalCatalog();
    const catalog = { roles: payload.roles || catalogBase.roles || [], capabilities: payload.capabilities || catalogBase.capabilities || [], operationalCities: catalogBase.operationalCities || [] };
    const access = payload.access || {};
    const shell = buildOperationalEditorShell(form, false);
    const currentModuleAccess = payload.moduleAccess || moduleAccessFromLegacy(form);
    fillRoleSelect(shell.roleSelect, catalog.roles, access.role || null, true);
    renderOperationalCityScope(shell, catalog.operationalCities, Object.prototype.hasOwnProperty.call(access, 'operationalCityIds') ? access.operationalCityIds : null);
    applyRoleDefaults(shell, catalog, access.role || null, access.effectivePermissions || [], currentModuleAccess);

    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = 'operationalAccessConfig';
    shell.section.append(hidden);
    permissionHost(form).append(shell.section);

    shell.roleSelect.addEventListener('change', () => {
      const role = shell.roleSelect.value || null;
      const roots = readModuleAccess(shell);
      applyRoleDefaults(shell, catalog, role, null, roots);
      shell.status.textContent = role
        ? 'Se cargó la base del nuevo rol. Revisa ciudades, módulos y funciones antes de guardar.'
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
      showNotice('Rol, ciudades, módulos y funciones aplicados al usuario creado.');
    } catch {
      showNotice('El usuario se creó, pero no fue posible aplicar su configuración operativa.', false);
    }
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();