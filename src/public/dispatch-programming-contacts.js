(() => {
  if (window.location.pathname !== '/admin/operaciones') return;

  const script = document.currentScript;
  const isDev = script?.dataset?.dev === 'true';
  const formats = document.querySelector('.programming-formats');
  if (!formats) return;

  formats.setAttribute('aria-label', 'Formatos para enviar reportes');
  const formatsTitle = formats.querySelector(':scope > strong');
  if (formatsTitle) formatsTitle.textContent = 'Enviar reportes:';

  const toast = document.getElementById('asyncToast');
  if (toast) {
    const replaceLegacyCopy = () => {
      if (toast.textContent.includes('gerentes')) {
        toast.textContent = toast.textContent.replace(/los gerentes/g, 'los destinatarios configurados').replace(/gerentes/g, 'destinatarios configurados');
      }
    };
    new MutationObserver(replaceLegacyCopy).observe(toast, { childList: true, subtree: true, characterData: true });
  }

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
  description.textContent = 'Estos números reciben los reportes. Cuando escriben al WhatsApp operativo pueden consultar Programación del día o Resumen del día dentro de la ventana de 24 horas.';
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

  function showMessage(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function field(labelText, type, attribute) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = type;
    input.maxLength = type === 'tel' ? 20 : 80;
    input.setAttribute(attribute, 'true');
    if (type === 'tel') input.inputMode = 'numeric';
    input.placeholder = type === 'tel' ? '3001234567' : 'Nombre';
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
    return [...recipientsWrap.querySelectorAll('.manager-row')]
      .map((row) => ({
        name: row.querySelector('[data-recipient-name]')?.value.trim() || '',
        phone: row.querySelector('[data-recipient-phone]')?.value.trim() || ''
      }))
      .filter((recipient) => recipient.name || recipient.phone);
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudieron guardar los destinatarios.');
      recipientsWrap.replaceChildren();
      const saved = Array.isArray(data.recipients) ? data.recipients : [];
      (saved.length ? saved : [{}]).forEach(addRecipientRow);
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
})();
