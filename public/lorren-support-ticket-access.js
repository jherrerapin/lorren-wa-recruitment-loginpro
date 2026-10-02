(() => {
  const TICKETS_PATH = '/admin/lorren-tickets';
  const ACCESS_ME_PATH = `${TICKETS_PATH}/access/me`;
  const ACCESS_USERS_PATH = `${TICKETS_PATH}/access/users`;
  const PENDING_CREATE_KEY = 'lorren.supportTickets.pendingCreateAccess';

  function ticketsLink() {
    const link = document.createElement('a');
    link.className = 'admin-module-standalone-link';
    if (window.location.pathname.startsWith(TICKETS_PATH)) link.classList.add('is-active');
    link.href = TICKETS_PATH;
    link.dataset.standaloneLink = 'tickets';
    link.textContent = 'Tickets';
    return link;
  }

  function ensureTicketsNavigation(allowed) {
    if (!allowed) return;
    const group = document.querySelector('[data-primary-nav-group="true"]');
    if (!group || group.querySelector('[data-standalone-link="tickets"]')) return;
    const anchor = group.querySelector('[data-standalone-link="branches"], [data-standalone-link="users"]');
    group.insertBefore(ticketsLink(), anchor || null);
  }

  async function saveUserAccess(userId, enabled) {
    const body = new URLSearchParams({ enabled: enabled ? 'true' : 'false' });
    const response = await fetch(`${ACCESS_USERS_PATH}/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json'
      },
      credentials: 'same-origin',
      body: body.toString()
    });
    if (!response.ok) throw new Error('No fue posible guardar el permiso de Tickets.');
    return response.json();
  }

  function statusNode() {
    const node = document.createElement('small');
    node.className = 'support-ticket-permission-status';
    node.style.display = 'block';
    node.style.marginTop = '4px';
    node.style.color = '#64748b';
    return node;
  }

  function appendSummary(drawer, enabled) {
    const row = drawer.closest('tr');
    const permissionsCell = row?.querySelector('td:nth-child(3)');
    if (!permissionsCell) return;
    const existing = permissionsCell.querySelector('[data-support-ticket-summary="true"]');
    if (!enabled) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const summary = document.createElement('small');
    summary.dataset.supportTicketSummary = 'true';
    summary.textContent = 'Tickets internos';
    permissionsCell.appendChild(summary);
  }

  function addEditPermission(drawer, enabled) {
    const userId = drawer.id.replace('edit-drawer-', '');
    if (!userId || drawer.querySelector('[data-support-ticket-permission="true"]')) return;
    const form = drawer.querySelector('form');
    if (!form) return;
    const fields = [...form.querySelectorAll('.field.full')];
    const permissionField = fields.find((field) => field.querySelector('label')?.textContent?.trim() === 'Permisos adicionales');
    if (!permissionField) return;

    const label = document.createElement('label');
    label.className = 'dispatch-row';
    label.dataset.supportTicketPermission = 'true';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(enabled);
    checkbox.dataset.supportTicketCheckbox = 'true';
    const text = document.createElement('span');
    text.innerHTML = '<strong>Tickets internos</strong><small>Permite abrir el módulo y crear tickets propios.</small>';
    label.append(checkbox, text);
    const status = statusNode();
    permissionField.append(label, status);
    appendSummary(drawer, checkbox.checked);

    form.addEventListener('submit', async (event) => {
      if (form.dataset.supportTicketAccessSaved === 'true') return;
      event.preventDefault();
      status.textContent = 'Guardando permiso de Tickets…';
      try {
        await saveUserAccess(userId, checkbox.checked);
        appendSummary(drawer, checkbox.checked);
        form.dataset.supportTicketAccessSaved = 'true';
        form.submit();
      } catch (error) {
        status.textContent = error?.message || 'No fue posible guardar el permiso de Tickets.';
        status.style.color = '#b91c1c';
      }
    });
  }

  function addCreatePermission() {
    const form = document.getElementById('createUserForm');
    if (!form || form.querySelector('[data-support-ticket-create="true"]')) return;
    const permissionStack = form.querySelector('.permission-stack');
    if (!permissionStack) return;
    const label = document.createElement('label');
    label.className = 'permission-card';
    label.dataset.supportTicketCreate = 'true';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'canAccessSupportTickets';
    const text = document.createElement('span');
    text.innerHTML = '<strong>Tickets internos</strong><small>Permite abrir el módulo y crear tickets propios.</small>';
    label.append(checkbox, text);
    permissionStack.appendChild(label);

    form.addEventListener('submit', () => {
      try {
        sessionStorage.setItem(PENDING_CREATE_KEY, checkbox.checked ? 'true' : 'false');
      } catch (_error) {
        // El alta del usuario no depende del almacenamiento del navegador.
      }
    });
  }

  async function applyPendingCreatedUserAccess() {
    const userId = new URLSearchParams(window.location.search).get('userId');
    if (!userId) return;
    let pending = null;
    try {
      pending = sessionStorage.getItem(PENDING_CREATE_KEY);
      sessionStorage.removeItem(PENDING_CREATE_KEY);
    } catch (_error) {
      return;
    }
    if (pending !== 'true') return;
    try {
      await saveUserAccess(userId, true);
    } catch (error) {
      console.warn('[lorren-support-ticket-access] no fue posible aplicar permiso inicial', error);
    }
  }

  async function enhanceUsersPage(dev) {
    if (!dev || window.location.pathname !== '/admin/users') return;
    addCreatePermission();
    await applyPendingCreatedUserAccess();
    const response = await fetch(ACCESS_USERS_PATH, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!response.ok) return;
    const payload = await response.json();
    const access = payload?.access || {};
    for (const drawer of document.querySelectorAll('.edit-drawer[id^="edit-drawer-"]')) {
      const userId = drawer.id.replace('edit-drawer-', '');
      addEditPermission(drawer, access[userId] === true);
    }
  }

  async function initialize() {
    try {
      const response = await fetch(ACCESS_ME_PATH, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!response.ok) return;
      const access = await response.json();
      ensureTicketsNavigation(access.allowed === true);
      await enhanceUsersPage(access.dev === true);
    } catch (error) {
      console.warn('[lorren-support-ticket-access] no fue posible cargar acceso', error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
