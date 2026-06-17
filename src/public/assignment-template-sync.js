(() => {
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

  function enhanceTemplate() {
    const template = document.getElementById('globalTemplate');
    if (!template || template.dataset.syncEnhanced === 'true') return;
    template.dataset.syncEnhanced = 'true';
    const helper = template.closest('.template-card')?.querySelector('p.muted');
    if (helper) helper.textContent = 'Edita esta plantilla general. El mensaje de cada auxiliar se actualizará automáticamente con este mismo contenido.';
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

  function getBogotaNowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date()).reduce((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  function parseRequestSchedule(card) {
    const text = card?.textContent || '';
    const match = text.match(/(20\d{2}-\d{2}-\d{2})\s*·\s*(\d{1,2}:\d{2})?/);
    return { date: match?.[1] || '', startTime: match?.[2] ? match[2].padStart(5, '0') : '' };
  }

  function isCurrentOrFutureRequest(card, now) {
    const schedule = parseRequestSchedule(card);
    if (!schedule.date) return true;
    if (schedule.date > now.date) return true;
    if (schedule.date < now.date) return false;
    if (!schedule.startTime) return true;
    return schedule.startTime >= now.time;
  }

  function filterCurrentServiceRequests() {
    const requestList = document.querySelector('.request-list');
    if (!requestList || requestList.dataset.currentFilterApplied === 'true') return;
    requestList.dataset.currentFilterApplied = 'true';
    const cards = Array.from(requestList.querySelectorAll('.request-card'));
    if (!cards.length) return;
    const now = getBogotaNowParts();
    let visibleCount = 0;
    let hiddenCount = 0;
    let selectedExpired = false;

    cards.forEach((card) => {
      const isCurrent = isCurrentOrFutureRequest(card, now);
      const isSelected = card.classList.contains('active');
      card.hidden = !isCurrent;
      card.dataset.hiddenByCurrentFilter = isCurrent ? 'false' : 'true';
      if (isCurrent) visibleCount += 1;
      else hiddenCount += 1;
      if (!isCurrent && isSelected) selectedExpired = true;
    });

    const head = requestList.closest('.board-panel')?.querySelector('.board-panel-head p');
    if (head) head.textContent = hiddenCount ? `Solo se muestran solicitudes vigentes desde la hora actual. ${hiddenCount} solicitud(es) vencida(s) ocultas.` : 'Elige la solicitud vigente sobre la que vas a trabajar.';

    if (!visibleCount && cards.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No hay solicitudes vigentes.</strong>Las solicitudes de días anteriores o con hora ya vencida se ocultan para mantener limpio el tablero.';
      requestList.appendChild(empty);
    }

    if (selectedExpired && visibleCount > 0) {
      const firstVisibleLink = cards.find((card) => !card.hidden)?.querySelector('a[href*="serviceRequestId="]');
      if (firstVisibleLink?.href) window.location.replace(firstVisibleLink.href);
    }
  }

  function boot() {
    hideRequesterNoticeWithoutContact();
    enhanceTemplate();
    filterCurrentServiceRequests();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
