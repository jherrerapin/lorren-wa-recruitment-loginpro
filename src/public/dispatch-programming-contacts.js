(() => {
  if (window.location.pathname !== '/admin/operaciones') return;
  const script = document.currentScript;
  const isDev = script?.dataset?.dev === 'true';
  const programmingCard = document.getElementById('programmingCard');
  const formats = document.querySelector('.programming-formats');
  if (!programmingCard || !formats) return;
  const toast = document.getElementById('asyncToast');
  const sendPdfCheckbox = document.getElementById('sendProgramPdf');
  const sendExcelCheckbox = document.getElementById('sendProgramExcel');
  let applyingFormats = false;

  function showMessage(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 3000);
  }
  function currentFormats() {
    const selected = [];
    if (sendPdfCheckbox?.checked) selected.push('pdf');
    if (sendExcelCheckbox?.checked) selected.push('excel');
    return selected;
  }
  function applyFormats(savedFormats) {
    const selected = new Set(Array.isArray(savedFormats) && savedFormats.length ? savedFormats : ['pdf']);
    applyingFormats = true;
    if (sendPdfCheckbox) sendPdfCheckbox.checked = selected.has('pdf');
    if (sendExcelCheckbox) sendExcelCheckbox.checked = selected.has('excel');
    sendPdfCheckbox?.dispatchEvent(new Event('change'));
    applyingFormats = false;
  }
  async function loadFormats() {
    try {
      const response = await fetch('/admin/operaciones/programacion/formatos', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudieron cargar los formatos.');
      applyFormats(data.formats);
    } catch (error) {
      showMessage(error.message || 'No se pudieron cargar los formatos guardados.');
    }
  }
  async function saveFormats(changedCheckbox) {
    if (applyingFormats || programmingCard.hidden) return;
    const selected = currentFormats();
    if (!selected.length) {
      if (changedCheckbox) changedCheckbox.checked = true;
      showMessage('Selecciona PDF, Excel o ambos.');
      return;
    }
    try {
      const response = await fetch('/admin/operaciones/programacion/formatos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ formats: selected })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudieron guardar los formatos.');
      applyFormats(data.formats);
    } catch (error) {
      showMessage(error.message || 'No se pudieron guardar los formatos.');
    }
  }
  sendPdfCheckbox?.addEventListener('change', () => saveFormats(sendPdfCheckbox));
  sendExcelCheckbox?.addEventListener('change', () => saveFormats(sendExcelCheckbox));

  function renderProgrammingUserAccess(users = []) {
    if (!isDev || document.getElementById('programmingUserAccess')) return;
    const section = document.createElement('div');
    section.id = 'programmingUserAccess';
    section.className = 'programming-recipients';
    section.setAttribute('aria-label', 'Visibilidad de Programación por usuario');
    const title = document.createElement('strong');
    title.textContent = 'Mostrar Programación a:';
    const choices = document.createElement('div');
    choices.className = 'programming-recipient-choices';
    const help = document.createElement('small');
    help.textContent = 'DEV siempre tiene acceso. Marca los usuarios que podrán ver y usar Programación del día.';
    const entries = Array.isArray(users) ? users : [];
    if (!entries.length) {
      const empty = document.createElement('span');
      empty.textContent = 'No hay usuarios de Operaciones configurables.';
      choices.appendChild(empty);
    }
    entries.forEach((user, index) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = user.enabled === true;
      input.id = `programmingAccess${index}`;
      const text = document.createElement('span');
      text.textContent = user.username || 'Usuario';
      label.htmlFor = input.id;
      label.append(input, text);
      input.addEventListener('change', async () => {
        const requested = input.checked;
        input.disabled = true;
        try {
          const response = await fetch('/admin/operaciones/programacion/acceso', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username, enabled: requested })
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudo cambiar la visibilidad.');
          input.checked = data.enabled === true;
          showMessage(`Programación ${input.checked ? 'habilitada' : 'oculta'} para ${user.username}.`);
        } catch (error) {
          input.checked = !requested;
          showMessage(error.message || 'No se pudo cambiar la visibilidad.');
        } finally {
          input.disabled = false;
        }
      });
      choices.appendChild(label);
    });
    section.append(title, choices, help);
    programmingCard.insertBefore(section, formats);
  }

  function setupDevRecipients() {
    if (!isDev || document.getElementById('programRecipients')) return;
    const section = document.createElement('div');
    section.className = 'programming-card';
    section.setAttribute('aria-label', 'Destinatarios de programación configurables por DEV');
    const head = document.createElement('div');
    head.className = 'programming-head';
    const headText = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = 'Destinatarios de programación';
    const description = document.createElement('p');
    description.textContent = 'Los checks PDF/Excel se usan para los envíos manuales. Cuando un destinatario pide Programación del día por WhatsApp, se le pregunta si la quiere en PDF, Excel o ambos.';
    headText.append(title, description);
    head.appendChild(headText);
    const recipientsWrap = document.createElement('div');
    recipientsWrap.id = 'programRecipients';
    const actions = document.createElement('div');
    actions.className = 'programming-actions';
    const addButton = document.createElement('button');
    addButton.className = 'btn';
    addButton.type = 'button';
    addButton.textContent = '+ Agregar destinatario';
    const saveButton = document.createElement('button');
    saveButton.className = 'btn btn-primary';
    saveButton.type = 'button';
    saveButton.textContent = 'Guardar destinatarios';
    actions.append(addButton, saveButton);
    section.append(head, recipientsWrap, actions);
    formats.insertAdjacentElement('afterend', section);

    function field(labelText, type, attribute) {
      const wrap = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = type;
      input.maxLength = type === 'tel' ? 20 : 80;
      input.setAttribute(attribute, 'true');
      if (type === 'tel') input.inputMode = 'numeric';
      input.placeholder = type === 'tel' ? 'Número de WhatsApp' : 'Nombre';
      label.appendChild(input);
      wrap.appendChild(label);
      return { wrap, input };
    }
    function addRecipientRow(recipient = {}) {
      const row = document.createElement('div');
      row.className = 'manager-row';
      const name = field('Nombre', 'text', 'data-recipient-name');
      const phone = field('Teléfono', 'tel', 'data-recipient-phone');
      name.input.value = recipient.name || '';
      phone.input.value = recipient.phone || '';
      const controls = document.createElement('div');
      controls.className = 'programming-actions';
      const devOnlyLabel = document.createElement('label');
      const devOnly = document.createElement('input');
      devOnly.type = 'checkbox';
      devOnly.checked = recipient.devOnly === true;
      devOnly.setAttribute('data-recipient-dev-only', 'true');
      const devOnlyText = document.createElement('span');
      devOnlyText.textContent = 'Solo DEV';
      devOnlyLabel.append(devOnly, devOnlyText);
      const remove = document.createElement('button');
      remove.className = 'btn';
      remove.type = 'button';
      remove.textContent = 'Quitar';
      remove.addEventListener('click', () => {
        row.remove();
        if (!recipientsWrap.children.length) addRecipientRow();
      });
      controls.append(devOnlyLabel, remove);
      row.append(name.wrap, phone.wrap, controls);
      recipientsWrap.appendChild(row);
    }
    function collectRecipients() {
      return [...recipientsWrap.querySelectorAll('.manager-row')].map((row) => ({
        name: row.querySelector('[data-recipient-name]')?.value.trim() || '',
        phone: row.querySelector('[data-recipient-phone]')?.value.trim() || '',
        devOnly: Boolean(row.querySelector('[data-recipient-dev-only]')?.checked)
      })).filter((recipient) => recipient.name || recipient.phone);
    }
    async function loadRecipients() {
      try {
        const response = await fetch('/admin/operaciones/programacion/destinatarios', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudieron cargar los destinatarios.');
        recipientsWrap.replaceChildren();
        const recipients = Array.isArray(data.recipients) ? data.recipients : [];
        (recipients.length ? recipients : [{}]).forEach(addRecipientRow);
      } catch (error) {
        recipientsWrap.replaceChildren();
        addRecipientRow();
        showMessage(error.message || 'No se pudieron cargar los destinatarios.');
      }
    }
    async function saveRecipients() {
      const recipients = collectRecipients();
      if (recipients.some((recipient) => !recipient.name || !recipient.phone)) {
        showMessage('Cada destinatario debe tener nombre y teléfono.');
        return;
      }
      saveButton.disabled = true;
      try {
        const response = await fetch('/admin/operaciones/programacion/destinatarios', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipients })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudieron guardar los destinatarios.');
        recipientsWrap.replaceChildren();
        const saved = Array.isArray(data.recipients) ? data.recipients : [];
        (saved.length ? saved : [{}]).forEach(addRecipientRow);
        if (typeof window.loadProgrammingRecipients === 'function') window.loadProgrammingRecipients();
        showMessage('Destinatarios guardados.');
      } catch (error) {
        showMessage(error.message || 'No se pudieron guardar los destinatarios.');
      } finally {
        saveButton.disabled = false;
      }
    }
    addButton.addEventListener('click', () => addRecipientRow());
    saveButton.addEventListener('click', saveRecipients);
    loadRecipients();
  }

  async function loadProgrammingAccess() {
    try {
      const response = await fetch('/admin/operaciones/programacion/acceso', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudo validar el acceso a Programación.');
      if (!data.allowed) return;
      programmingCard.hidden = false;
      await loadFormats();
      if (typeof window.loadProgrammingRecipients === 'function') window.loadProgrammingRecipients();
      if (isDev && data.isDev) {
        renderProgrammingUserAccess(data.users);
        setupDevRecipients();
      }
    } catch (error) {
      programmingCard.hidden = true;
      if (isDev) showMessage(error.message || 'No se pudo validar el acceso a Programación.');
    }
  }

  loadProgrammingAccess();
})();
