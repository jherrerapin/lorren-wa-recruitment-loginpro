(() => {
  if (window.location.pathname !== '/admin/operaciones') return;
  const script = document.currentScript;
  const isDev = script?.dataset?.dev === 'true';
  const programmingCard = document.getElementById('programmingCard') || document.querySelector('[aria-label="Programación del día"]');
  const formats = document.querySelector('.programming-formats');
  if (!programmingCard || !formats) return;

  function setProgrammingCardVisible(visible) {
    programmingCard.hidden = !visible;
    programmingCard.style.display = visible ? '' : 'none';
  }

  setProgrammingCardVisible(false);
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

  function setupDevRecipients() {
    if (!isDev || document.getElementById('programRecipients')) return;

    function field(labelText, type, attribute, placeholder) {
      const wrap = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = type;
      input.maxLength = type === 'tel' ? 20 : 120;
      input.setAttribute(attribute, 'true');
      if (type === 'tel') input.inputMode = 'numeric';
      input.placeholder = placeholder || (type === 'tel' ? 'Número de WhatsApp' : 'Nombre');
      label.appendChild(input);
      wrap.appendChild(label);
      return { wrap, input };
    }

    const devSection = document.createElement('div');
    devSection.className = 'programming-card';
    devSection.setAttribute('aria-label', 'Contacto privado de DEV para programación');
    const devHead = document.createElement('div');
    devHead.className = 'programming-head';
    const devHeadText = document.createElement('div');
    const devTitle = document.createElement('h2');
    devTitle.textContent = 'Contacto DEV para Programación';
    const devDescription = document.createElement('p');
    devDescription.textContent = 'Solo DEV puede ver y editar estos datos. Si configuras un WhatsApp, tu contacto aparecerá únicamente en tu lista de destinatarios del informe.';
    devHeadText.append(devTitle, devDescription);
    devHead.appendChild(devHeadText);
    const devRow = document.createElement('div');
    devRow.className = 'manager-row';
    const devEmail = field('Correo DEV', 'email', 'data-dev-contact-email', 'correo@ejemplo.com');
    const devPhone = field('WhatsApp DEV', 'tel', 'data-dev-contact-phone', 'Número de WhatsApp');
    const devSave = document.createElement('button');
    devSave.className = 'btn btn-primary';
    devSave.type = 'button';
    devSave.textContent = 'Guardar contacto DEV';
    devRow.append(devEmail.wrap, devPhone.wrap, devSave);
    devSection.append(devHead, devRow);

    const section = document.createElement('div');
    section.className = 'programming-card';
    section.setAttribute('aria-label', 'Destinatarios generales de programación configurables por DEV');
    const head = document.createElement('div');
    head.className = 'programming-head';
    const headText = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = 'Destinatarios de programación';
    const description = document.createElement('p');
    description.textContent = 'Estos destinatarios son generales. El contacto privado de DEV se configura aparte y nunca se expone a otros usuarios.';
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
    formats.insertAdjacentElement('afterend', devSection);
    devSection.insertAdjacentElement('afterend', section);

    function addRecipientRow(recipient = {}) {
      const row = document.createElement('div');
      row.className = 'manager-row';
      const name = field('Nombre', 'text', 'data-recipient-name');
      const phone = field('Teléfono', 'tel', 'data-recipient-phone');
      name.input.value = recipient.name || '';
      phone.input.value = recipient.phone || '';
      const remove = document.createElement('button');
      remove.className = 'btn';
      remove.type = 'button';
      remove.textContent = 'Quitar';
      remove.addEventListener('click', () => {
        row.remove();
        if (!recipientsWrap.children.length) addRecipientRow();
      });
      row.append(name.wrap, phone.wrap, remove);
      recipientsWrap.appendChild(row);
    }

    function collectRecipients() {
      return [...recipientsWrap.querySelectorAll('.manager-row')].map((row) => ({
        name: row.querySelector('[data-recipient-name]')?.value.trim() || '',
        phone: row.querySelector('[data-recipient-phone]')?.value.trim() || ''
      })).filter((recipient) => recipient.name || recipient.phone);
    }

    async function loadRecipients() {
      try {
        const response = await fetch('/admin/operaciones/programacion/destinatarios', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudieron cargar los destinatarios.');
        devEmail.input.value = data.devContact?.email || '';
        devPhone.input.value = data.devContact?.phone || '';
        recipientsWrap.replaceChildren();
        const recipients = Array.isArray(data.recipients) ? data.recipients : [];
        (recipients.length ? recipients : [{}]).forEach(addRecipientRow);
      } catch (error) {
        recipientsWrap.replaceChildren();
        addRecipientRow();
        showMessage(error.message || 'No se pudieron cargar los destinatarios.');
      }
    }

    async function saveDevContact() {
      devSave.disabled = true;
      try {
        const response = await fetch('/admin/operaciones/programacion/dev-contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: devEmail.input.value.trim(), phone: devPhone.input.value.trim() })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudo guardar el contacto DEV.');
        devEmail.input.value = data.devContact?.email || '';
        devPhone.input.value = data.devContact?.phone || '';
        await loadRecipients();
        if (typeof window.loadProgrammingRecipients === 'function') await window.loadProgrammingRecipients();
        showMessage('Contacto DEV guardado.');
      } catch (error) {
        showMessage(error.message || 'No se pudo guardar el contacto DEV.');
      } finally {
        devSave.disabled = false;
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
        if (typeof window.loadProgrammingRecipients === 'function') await window.loadProgrammingRecipients();
        showMessage('Destinatarios guardados.');
      } catch (error) {
        showMessage(error.message || 'No se pudieron guardar los destinatarios.');
      } finally {
        saveButton.disabled = false;
      }
    }

    devSave.addEventListener('click', saveDevContact);
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
      setProgrammingCardVisible(true);
      await loadFormats();
      if (typeof window.loadProgrammingRecipients === 'function') window.loadProgrammingRecipients();
      if (isDev && data.isDev) setupDevRecipients();
    } catch (error) {
      setProgrammingCardVisible(false);
      if (isDev) showMessage(error.message || 'No se pudo validar el acceso a Programación.');
    }
  }

  loadProgrammingAccess();
})();
