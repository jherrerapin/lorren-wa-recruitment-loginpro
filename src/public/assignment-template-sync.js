(() => {
  const DEFAULT_ASSIGNMENT_TEMPLATE = [
    'Buenas tardes {{nombre}},',
    '',
    'Mañana: {{fecha}} ',
    'Estar en: {{operacion}}  - {{direccion}}',
    'Hora : {{horaInicio}} por favor.',
    '',
    '',
    'Confirmado?'
  ].join('\n');

  function refreshMessageData() {
    if (typeof window.refreshWhatsappLinks === 'function') {
      window.refreshWhatsappLinks();
      return;
    }
    document.querySelectorAll('.assignment-message').forEach((textarea) => {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function syncTemplateToMessages() {
    const template = document.getElementById('globalTemplate');
    if (!template) return;
    document.querySelectorAll('.assignment-message').forEach((textarea) => {
      textarea.value = template.value || '';
    });
    refreshMessageData();
  }

  function showBulkSendToast(message) {
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }
    const toast = document.getElementById('asyncToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showBulkSendToast._t);
    showBulkSendToast._t = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function shouldReplaceTemplate(value) {
    const current = String(value || '').trim();
    if (!current) return true;
    return /te\s+confirmamos\s+asignaci/i.test(current) || /Por\s+favor\s+confirma\s+recibido/i.test(current);
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
      refreshMessageData();
      const buttons = [...document.querySelectorAll('.assigned-card .whatsapp-link.dispatch-wa-button')]
        .filter((item) => !item.disabled && item.dataset.waPhone && item.dataset.waMessage);
      if (!buttons.length) {
        showBulkSendToast('No hay auxiliares con WhatsApp y mensaje listo para enviar.');
        return;
      }
      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = `Enviando 0/${buttons.length}...`;
      for (let index = 0; index < buttons.length; index += 1) {
        const whatsappButton = buttons[index];
        button.textContent = `Enviando ${index + 1}/${buttons.length}...`;
        if (typeof window.sendDispatchWhatsapp === 'function') {
          await window.sendDispatchWhatsapp(whatsappButton);
        } else {
          whatsappButton.click();
          await new Promise((resolve) => window.setTimeout(resolve, 900));
        }
      }
      button.disabled = false;
      button.textContent = originalText;
      showBulkSendToast('Mensajes enviados a los auxiliares con número disponible.');
    });
    const variables = templateCard.querySelector('.variable-row');
    if (variables) variables.insertAdjacentElement('afterend', button);
    else templateCard.appendChild(button);
  }

  function enhanceTemplate() {
    const template = document.getElementById('globalTemplate');
    if (!template || template.dataset.syncEnhanced === 'true') return;
    template.dataset.syncEnhanced = 'true';
    if (shouldReplaceTemplate(template.value)) template.value = DEFAULT_ASSIGNMENT_TEMPLATE;
    const helper = template.closest('.template-card')?.querySelector('p.muted');
    if (helper) helper.textContent = 'Edita esta plantilla general. El mensaje de cada auxiliar se actualizará automáticamente con este mismo contenido.';
    addBulkSendButton(template);
    template.addEventListener('input', syncTemplateToMessages);
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('.variable-row[data-target="globalTemplate"] .variable-btn');
      if (!button) return;
      window.setTimeout(syncTemplateToMessages, 0);
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
    const spans = [...card.querySelectorAll('.meta span')];
    const scheduleText = spans.map((span) => span.textContent || '').find((text) => /\d{4}-\d{2}-\d{2}/.test(text));
    if (!scheduleText) return null;
    const match = scheduleText.match(/(\d{4}-\d{2}-\d{2})\s*·\s*([0-2]?\d:[0-5]\d)?/);
    if (!match) return null;
    const date = match[1];
    const time = match[2] || '23:59';
    const start = new Date(`${date}T${time.padStart(5, '0')}:00-05:00`);
    return Number.isNaN(start.getTime()) ? null : start;
  }

  function visibleRequestCards(cards) {
    return cards.filter((card) => !card.hidden && card.dataset.expiredServiceRequest !== 'true');
  }

  function redirectToFirstVisibleRequest(cards) {
    const firstVisible = visibleRequestCards(cards)[0];
    const selectLink = firstVisible?.querySelector('.request-actions a[href*="serviceRequestId="]');
    if (selectLink?.href && window.location.href !== selectLink.href) {
      window.location.replace(selectLink.href);
      return true;
    }
    return false;
  }

  function filterExpiredServiceRequests() {
    const list = document.querySelector('.request-list');
    if (!list || list.dataset.currentFilterApplied === 'true') return;
    list.dataset.currentFilterApplied = 'true';

    const now = new Date();
    const cards = [...list.querySelectorAll('.request-card')];
    let visibleCount = 0;
    let hiddenCount = 0;

    cards.forEach((card) => {
      const requestStart = parseRequestStart(card);
      const isExpired = requestStart ? requestStart < now : false;
      card.hidden = isExpired;
      card.dataset.expiredServiceRequest = isExpired ? 'true' : 'false';
      if (!isExpired) visibleCount += 1;
      else hiddenCount += 1;
    });

    const head = list.closest('.board-panel')?.querySelector('.board-panel-head p');
    if (head) {
      head.textContent = hiddenCount
        ? `Solo se muestran solicitudes vigentes desde la hora actual. ${hiddenCount} solicitud(es) vencida(s) ocultas.`
        : 'Elige la solicitud vigente sobre la que vas a trabajar.';
    }

    const activeCard = list.querySelector('.request-card.active');
    if (activeCard?.hidden && redirectToFirstVisibleRequest(cards)) return;

    if (!visibleCount && cards.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No hay solicitudes vigentes para asignar.</strong>Solo se muestran servicios cuya fecha y hora aún no han pasado.';
      list.appendChild(empty);
    }
  }

  function boot() {
    hideRequesterNoticeWithoutContact();
    enhanceTemplate();
    filterExpiredServiceRequests();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
