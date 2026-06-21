(() => {
  const EXPIRED_EDIT_MESSAGE = 'Esta solicitud ya superó las 2 horas posteriores a la hora del servicio. Puedes verla a detalle, pero no editarla.';
  const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g;

  function formatTimeAmPm(value) {
    const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return String(value || '').trim();
    let hour = Number(match[1]);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${match[2]} ${suffix}`;
  }

  function formatTimeText(value) {
    return String(value || '').replace(TIME_RE, (_full, hour, minute) => formatTimeAmPm(`${hour}:${minute}`));
  }

  function formatVisibleTimes(root = document.body) {
    const skip = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const parent = node.parentElement;
      if (!parent || skip.has(parent.tagName)) return;
      const current = node.nodeValue || '';
      const formatted = formatTimeText(current);
      if (formatted !== current) node.nodeValue = formatted;
    });
  }

  function normalizeAssignmentStartTimes() {
    document.querySelectorAll('.assigned-card[data-start], .request-card[data-start], [data-start-time], [data-end-time]').forEach((element) => {
      ['start', 'end', 'startTime', 'endTime'].forEach((key) => {
        if (!element.dataset || !(key in element.dataset)) return;
        const formatted = formatTimeAmPm(element.dataset[key]);
        if (formatted) element.dataset[key] = formatted;
      });
    });
  }

  function normalizeAssignmentTemplate(value) {
    return String(value || '')
      .replace(/\*?\{\{\s*nombre\s*\}\}\*?/gi, '*{{nombre}}*')
      .replace(/\*?\{\{\s*fecha\s*\}\}\*?/gi, '*{{fecha}}*')
      .replace(/\*?\{\{\s*operacion\s*\}\}\*?/gi, '*{{operacion}}*')
      .replace(/\*?\{\{\s*direccion\s*\}\}\*?/gi, '*{{direccion}}*')
      .replace(/\*?\{\{\s*horaInicio\s*\}\}\*?/gi, '*{{horaInicio}}*')
      .replace(/\*\*+/g, '*');
  }

  function buildDefaultAssignmentTemplate() {
    return [
      'Hola *{{nombre}}*,',
      '',
      'Mañana: *{{fecha}}*',
      'Llegar a: *{{operacion}}*',
      'Ubicacion: *{{direccion}}*',
      'Hora : *{{horaInicio}}* por favor.',
      '',
      '',
      'Confirmado?'
    ].join('\n');
  }

  function refreshMessageData() {
    normalizeAssignmentStartTimes();
    if (typeof window.refreshWhatsappLinks === 'function') {
      window.refreshWhatsappLinks();
      return;
    }
    document.querySelectorAll('.assignment-message').forEach((textarea) => textarea.dispatchEvent(new Event('input', { bubbles: true })));
  }

  function syncTemplateToMessages() {
    const template = document.getElementById('globalTemplate');
    if (!template) return;
    const normalizedTemplate = normalizeAssignmentTemplate(template.value || '');
    if (template.value !== normalizedTemplate) template.value = normalizedTemplate;
    document.querySelectorAll('.assignment-message').forEach((textarea) => { textarea.value = normalizedTemplate; });
    refreshMessageData();
  }

  function showToast(message) {
    if (typeof window.showToast === 'function') return window.showToast(message);
    const toast = document.getElementById('asyncToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function shouldReplaceTemplate(value) {
    const current = String(value || '').trim();
    if (!current) return true;
    return /te\s+confirmamos\s+asignaci/i.test(current)
      || /Por\s+favor\s+confirma\s+recibido/i.test(current)
      || /^Buenas\s+(d[ií]as|tardes|noches)\s+\*?\{\{\s*nombre\s*\}\}\*?/i.test(current)
      || /^Hola\s+\*?\{\{\s*nombre\s*\}\}\*?,[\s\S]*Estar\s+en:/i.test(current)
      || /^Hola\s+\*?\{\{\s*nombre\s*\}\}\*?,[\s\S]*Llegar\s+a:/i.test(current);
  }

  function addBulkSendButton(template) {
    const templateCard = template.closest('.template-card');
    if (!templateCard || templateCard.querySelector('#sendAllAssignmentMessages')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'sendAllAssignmentMessages';
    button.className = 'btn btn-primary';
    button.textContent = 'Enviar mensaje a todos';
    button.style.marginTop = '8px';
    button.addEventListener('click', async () => {
      syncTemplateToMessages();
      const buttons = [...document.querySelectorAll('.assigned-card .whatsapp-link.dispatch-wa-button')]
        .filter((item) => !item.disabled && item.dataset.waPhone && item.dataset.waMessage);
      if (!buttons.length) return showToast('No hay auxiliares con WhatsApp y mensaje listo para enviar.');
      button.disabled = true;
      const originalText = button.textContent;
      for (let index = 0; index < buttons.length; index += 1) {
        button.textContent = `Enviando ${index + 1}/${buttons.length}...`;
        if (typeof window.sendDispatchWhatsapp === 'function') await window.sendDispatchWhatsapp(buttons[index]);
        else buttons[index].click();
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
      button.disabled = false;
      button.textContent = originalText;
      showToast('Mensajes enviados a los auxiliares con número disponible.');
    });
    const variables = templateCard.querySelector('.variable-row');
    if (variables) variables.insertAdjacentElement('afterend', button);
    else templateCard.appendChild(button);
  }

  function enhanceTemplate() {
    const template = document.getElementById('globalTemplate');
    if (!template || template.dataset.syncEnhanced === 'true') return;
    template.dataset.syncEnhanced = 'true';
    template.value = shouldReplaceTemplate(template.value) ? buildDefaultAssignmentTemplate() : normalizeAssignmentTemplate(template.value || '');
    const helper = template.closest('.template-card')?.querySelector('p.muted');
    if (helper) helper.textContent = 'Edita esta plantilla general. El mensaje de cada auxiliar se actualizará automáticamente con este mismo contenido.';
    addBulkSendButton(template);
    template.addEventListener('input', syncTemplateToMessages);
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('.variable-row[data-target="globalTemplate"] .variable-btn');
      if (button) window.setTimeout(syncTemplateToMessages, 0);
    });
    window.setTimeout(syncTemplateToMessages, 80);
  }

  function hideRequesterNoticeWithoutContact() {
    const block = document.querySelector('.notify-block');
    if (!block || block.dataset.contactChecked === 'true') return;
    block.dataset.contactChecked = 'true';
    const hasContact = Boolean(block.querySelector('.notify-contact'));
    const hasActions = Boolean(block.querySelector('.notify-actions'));
    if (hasContact || hasActions) return;
    const note = document.createElement('div');
    note.className = 'section-note';
    note.innerHTML = '<strong>Notificación al solicitante no disponible.</strong><br>Esta solicitud no tiene datos de contacto del solicitante registrados.';
    block.replaceWith(note);
  }

  function parseRequestStart(card) {
    const scheduleText = [...card.querySelectorAll('.meta span')].map((span) => span.textContent || '').find((text) => /\d{4}-\d{2}-\d{2}/.test(text));
    const match = scheduleText?.match(/(\d{4}-\d{2}-\d{2})\s*·\s*([0-2]?\d:[0-5]\d)?/);
    if (!match) return null;
    const time = match[2] || '23:59';
    const start = new Date(`${match[1]}T${time.padStart(5, '0')}:00-05:00`);
    return Number.isNaN(start.getTime()) ? null : start;
  }

  function filterExpiredServiceRequests() {
    const list = document.querySelector('.request-list');
    if (!list || list.dataset.currentFilterApplied === 'true') return;
    list.dataset.currentFilterApplied = 'true';
    const cards = [...list.querySelectorAll('.request-card')];
    let hiddenCount = 0;
    cards.forEach((card) => {
      const requestStart = parseRequestStart(card);
      const isExpired = requestStart ? requestStart < new Date() : false;
      card.hidden = isExpired;
      card.dataset.expiredServiceRequest = isExpired ? 'true' : 'false';
      if (isExpired) hiddenCount += 1;
    });
    const head = list.closest('.board-panel')?.querySelector('.board-panel-head p');
    if (head && hiddenCount) head.textContent = `Solo se muestran solicitudes vigentes desde la hora actual. ${hiddenCount} solicitud(es) vencida(s) ocultas.`;
  }

  function enhanceExpiredEditModal() {
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href*="/asignaciones/solicitudes/"][href$="/editar"], a[data-expired-edit="true"]');
      if (!link) return;
      const card = link.closest('.request-card');
      const requestStart = card ? parseRequestStart(card) : null;
      if (!requestStart || Date.now() <= requestStart.getTime() + (2 * 60 * 60 * 1000)) return;
      event.preventDefault();
      showToast(link.dataset.expiredMessage || EXPIRED_EDIT_MESSAGE);
    });
  }

  function boot() {
    normalizeAssignmentStartTimes();
    formatVisibleTimes();
    hideRequesterNoticeWithoutContact();
    enhanceTemplate();
    enhanceExpiredEditModal();
    filterExpiredServiceRequests();
    refreshMessageData();
    const observer = new MutationObserver(() => {
      normalizeAssignmentStartTimes();
      formatVisibleTimes();
      refreshMessageData();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.LoginProTimeFormat = { ...(window.LoginProTimeFormat || {}), formatTimeAmPm, formatTimeText, formatVisibleTimes };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
