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

  function parseRequestDateTime(card) {
    const text = card?.textContent || '';
    const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const timeMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (!dateMatch) return null;
    const time = timeMatch ? `${String(timeMatch[1]).padStart(2, '0')}:${timeMatch[2]}` : '23:59';
    return new Date(`${dateMatch[1]}T${time}:00-05:00`);
  }

  function filterCurrentServiceRequests() {
    const requestList = document.querySelector('.request-list');
    if (!requestList || requestList.dataset.currentFilterApplied === 'true') return;
    requestList.dataset.currentFilterApplied = 'true';
    const now = new Date();
    const cards = Array.from(requestList.querySelectorAll('.request-card'));
    let visibleCount = 0;
    let hiddenCount = 0;
    cards.forEach((card) => {
      const requestDateTime = parseRequestDateTime(card);
      const isCurrent = !requestDateTime || requestDateTime >= now;
      card.hidden = !isCurrent;
      card.dataset.hiddenByCurrentFilter = isCurrent ? 'false' : 'true';
      if (isCurrent) visibleCount += 1;
      else hiddenCount += 1;
    });
    const head = requestList.closest('.board-panel')?.querySelector('.board-panel-head p');
    if (head) head.textContent = hiddenCount ? `Solo se muestran solicitudes vigentes desde la hora actual. ${hiddenCount} solicitud(es) vencida(s) ocultas.` : 'Elige la solicitud vigente sobre la que vas a trabajar.';
    if (!visibleCount && cards.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No hay solicitudes vigentes.</strong>Las solicitudes de días anteriores o con hora ya vencida se ocultan para mantener limpio el tablero.';
      requestList.appendChild(empty);
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
