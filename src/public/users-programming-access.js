(() => {
  if (window.location.pathname !== '/admin/users') return;

  const ACCESS_ENDPOINT = '/admin/operaciones/programacion/acceso';
  const USER_ACCESS_FORM_PATTERN = /^\/admin\/locations\/users\/([^/]+)\/access$/;

  function formUsername(form) {
    const title = form.querySelector('.edit-drawer-title')?.textContent?.trim() || '';
    return title.replace(/^Editar usuario\s+/i, '').trim();
  }

  function formUserId(form) {
    try {
      return new URL(form.action, window.location.origin).pathname.match(USER_ACCESS_FORM_PATTERN)?.[1] || '';
    } catch (_error) {
      return '';
    }
  }

  function redirectWithError(message) {
    const params = new URLSearchParams();
    params.set('error', message || 'No se pudo actualizar el acceso a Programación.');
    window.location.assign(`/admin/users?${params.toString()}`);
  }

  async function saveProgrammingAccess(username, enabled) {
    const response = await fetch(ACCESS_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, enabled })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.message || 'No se pudo actualizar el acceso a Programación.');
    }
    return data.enabled === true;
  }

  async function submitUserAccessForm(form) {
    const response = await fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      body: new FormData(form),
      redirect: 'follow'
    });
    if (!response.ok) throw new Error('No se pudieron guardar los permisos del usuario.');

    const finalUrl = new URL(response.url || '/admin/users', window.location.origin);
    const errorMessage = finalUrl.searchParams.get('error');
    if (errorMessage) throw new Error(errorMessage);
    return finalUrl.href;
  }

  function buildProgrammingPermission({ form, username, enabled }) {
    const dispatchInput = form.querySelector('input[name="canAccessDispatch"]');
    if (!dispatchInput) return;

    const permissionsField = dispatchInput.closest('.field.full');
    const dispatchLabel = dispatchInput.closest('label');
    if (!permissionsField || !dispatchLabel || permissionsField.querySelector('[data-programming-user-permission]')) return;

    const userId = formUserId(form) || username.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const label = document.createElement('label');
    label.className = 'dispatch-row';
    label.setAttribute('data-programming-user-permission', 'true');

    const input = document.createElement('input');
    input.id = `edit-canAccessProgramming-${userId}`;
    input.type = 'checkbox';
    input.name = 'canAccessProgramming';
    input.value = 'true';
    input.checked = enabled;
    input.setAttribute('data-programming-initial', enabled ? 'true' : 'false');

    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = 'Programación del día';
    const help = document.createElement('small');
    help.textContent = 'DEV habilita o deshabilita este acceso para este usuario. Al activarlo también se habilita Operaciones / Despacho.';
    text.append(title, help);
    label.append(input, text);
    dispatchLabel.insertAdjacentElement('afterend', label);

    input.addEventListener('change', () => {
      if (input.checked) dispatchInput.checked = true;
    });

    form.addEventListener('submit', async (event) => {
      if (form.dataset.programmingSubmit === 'running') {
        event.preventDefault();
        return;
      }

      const initialEnabled = input.dataset.programmingInitial === 'true';
      const requestedEnabled = input.checked;
      if (requestedEnabled) dispatchInput.checked = true;

      if (requestedEnabled === initialEnabled) return;

      event.preventDefault();
      form.dataset.programmingSubmit = 'running';
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      try {
        let redirectUrl;
        if (!requestedEnabled) {
          await saveProgrammingAccess(username, false);
          redirectUrl = await submitUserAccessForm(form);
        } else {
          redirectUrl = await submitUserAccessForm(form);
          await saveProgrammingAccess(username, true);
        }
        window.location.assign(redirectUrl || '/admin/users');
      } catch (error) {
        redirectWithError(error.message || 'No se pudo actualizar el acceso a Programación.');
      }
    });
  }

  async function initialize() {
    const editableForms = [...document.querySelectorAll('form[action^="/admin/locations/users/"][action$="/access"]')];
    if (!editableForms.length) return;

    try {
      const response = await fetch(ACCESS_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok || !data.ok || data.isDev !== true) return;

      const accessByUsername = new Map(
        (Array.isArray(data.users) ? data.users : []).map((user) => [String(user.username || '').trim(), user.enabled === true])
      );

      editableForms.forEach((form) => {
        const username = formUsername(form);
        if (!username) return;
        buildProgrammingPermission({
          form,
          username,
          enabled: accessByUsername.get(username) === true
        });
      });
    } catch (_error) {
      // Si no se puede validar que la sesión es DEV, no se expone el control.
    }
  }

  initialize();
})();