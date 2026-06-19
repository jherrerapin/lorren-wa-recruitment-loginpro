(() => {
  const EXPIRED_EDIT_MESSAGE = 'Esta solicitud ya superó las 2 horas posteriores a la hora del servicio. Puedes verla a detalle, pero no editarla.';
  const WHATSAPP_BOLD_VARIABLES = {
    nombre: 'nombre',
    fecha: 'fecha',
    operacion: 'operacion',
    direccion: 'direccion',
    horainicio: 'horaInicio'
  };

  function boldWhatsappVariables(value) {
    return String(value || '').replace(/\*?\{\{\s*(nombre|fecha|operacion|direccion|horaInicio)\s*\}\}\*?/gi, (_match, token) => {
      const normalized = WHATSAPP_BOLD_VARIABLES[String(token || '').toLowerCase()] || token;
      return `*{{${normalized}}}*`;
    });
  }

  function currentGreeting(date = new Date()) {
    const hour = Number(new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }).format(date));
    if (hour >= 5 && hour < 12) return 'Buenos días';
    if (hour >= 12 && hour < 19) return 'Buenas tardes';
    return 'Buenas noches';
  }

  function buildDefaultAssignmentTemplate() {
    return boldWhatsappVariables([
      `${currentGreeting()} {{nombre}},`,
      '',
      'Mañana: {{fecha}} ',
      'Estar en: {{operacion}}  - {{direccion}}',
      'Hora : {{horaInicio}} por favor.',
      '',
      '',
      'Confirmado?'
    ].join('\n'));
  }

  function ensureExpiredModal() {
    let modal = document.getElementById('expiredServiceRequestModal');
    if (modal) return modal;

    const style = document.createElement('style');
    style.textContent = `
      .expired-service-modal{position:fixed;inset:0;background:rgba(15,23,42,.46);display:flex;align-items:center;justify-content:center;padding:18px;z-index:10000;opacity:0;pointer-events:none;transition:opacity .18s ease}.expired-service-modal.show{opacity:1;pointer-events:auto}.expired-service-card{width:min(430px,100%);background:#fff;border-radius:18px;border:1px solid #e5e7eb;box-shadow:0 24px 70px rgba(15,23,42,.28);overflow:hidden;transform:translateY(8px);transition:transform .18s ease}.expired-service-modal.show .expired-service-card{transform:translateY(0)}.expired-service-head{display:flex;gap:12px;align-items:flex-start;padding:18px 18px 10px}.expired-service-icon{width:42px;height:42px;border-radius:999px;background:#fffbeb;color:#92400e;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;flex:0 0 auto}.expired-service-title{margin:0;color:#172033;font-size:18px;line-height:1.25}.expired-service-text{margin:5px 0 0;color:#64748b;font-size:13px;line-height:1.45}.expired-service-actions{padding:14px 18px 18px;display:flex;justify-content:flex-end}.expired-service-actions button{border:1px solid #0d7a6b;background:#0d7a6b;color:#fff;border-radius:999px;padding:9px 18px;font-weight:900;cursor:pointer}.expired-service-actions button:hover{background:#0b665a}`;
    document.head.appendChild(style);

    modal = document.createElement('div');
    modal.id = 'expiredServiceRequestModal';
    modal.className = 'expired-service-modal';
    modal.innerHTML = `
      <div class="expired-service-card" role="dialog" aria-modal="true" aria-labelledby="expiredServiceRequestTitle">
        <div class="expired-service-head">
          <div class="expired-service-icon">!</div>
          <div>
            <h2 class="expired-service-title" id="expiredServiceRequestTitle">Solicitud solo para consulta</h2>
            <p class="expired-service-text" id="expiredServiceRequestText"></p>
          </div>
        </div>
        <div class="expired-service-actions"><button type="button" id="expiredServiceRequestAccept">Aceptar</button></div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.classList.remove('show');
    modal.querySelector('#expiredServiceRequestAccept')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    return modal;
  }

  function showExpiredEditModal(message = EXPIRED_EDIT_MESSAGE) {
    const modal = ensureExpiredModal();
    const text = modal.querySelector('#expiredServiceRequestText');
    if (text) text.textContent = message;
    modal.classList.add('show');
    window.setTimeout(() => modal.querySelector('#expiredServiceRequestAccept')?.focus(), 30);
  }

  function parseServiceStartFromElement(element) {
    const directDate = element?.dataset?.serviceDate;
    const directTime = element?.dataset?.startTime;
    if (directDate) return buildServiceStart(directDate, directTime);
    const card = element?.closest?.('.request-card');
    const scheduleText = [...(card?.querySelectorAll('.meta span') || [])]
      .map((span) => span.textContent || '')
      .find((text) => /\d{4}-\d{2}-\d{2}/.test(text));
    if (!scheduleText) return null;
    const match = scheduleText.match(/(\d{4}-\d{2}-\d{2})\s*·\s*([0-2]?\d:[0-5]\d)?/);
    if (!match) return null;
    return buildServiceStart(match[1], match[2]);
  }

  function buildServiceStart(date, time) {
    const startTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(time || '')) ? String(time).padStart(5, '0') : '00:00';
    const start = new Date(`${date}T${startTime}:00-05:00`);
    return Number.isNaN(start.getTime()) ? null : start;
  }

  function isEditLocked(start, now = new Date()) {
    if (!start) return false;
    return now.getTime() > start.getTime() + (2 * 60 * 60 * 1000);
  }

  function enhanceExpiredEditModal() {
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href*="/asignaciones/solicitudes/"][href$="/editar"], a[data-expired-edit="true"]');
      if (!link) return;
      const start = parseServiceStartFromElement(link);
      if (!isEditLocked(start)) return;
      event.preventDefault();
      showExpiredEditModal(link.dataset.expiredMessage || EXPIRED_EDIT_MESSAGE);
    });
  }

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
    const normalizedTemplate = boldWhatsappVariables(template.value || '');
    if (template.value !== normalizedTemplate) template.value = normalizedTemplate;
    document.querySelectorAll('.assignment-message').forEach((textarea) => {
      textarea.value = normalizedTemplate;
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
    return /te\s+confirmamos\s+asignaci/i.test(current)
      || /Por\s+favor\s+confirma\s+recibido/i.test(current)
      || /^Buenas\s+(d[ií]as|tardes|noches)\s+\*?\{\{\s*nombre\s*\}\}\*?/i.test(current);
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
    if (shouldReplaceTemplate(template.value)) template.value = buildDefaultAssignmentTemplate();
    else template.value = boldWhatsappVariables(template.value || '');
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
    enhanceExpiredEditModal();
    filterExpiredServiceRequests();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
