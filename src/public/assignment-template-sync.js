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

  function parseRequestStart(card) {
    const spans = [...card.querySelectorAll('.meta span')];
    const scheduleText = spans.map((span) => span.textContent || '').find((text) => /\d{4}-\d{2}-\d{2}/.test(text));
    if (!scheduleText) return null;
    const match = scheduleText.match(/(\d{4}-\d{2}-\d{2})\s*·\s*([0-2]?\d:[0-5]\d)?/);
    if (!match) return null;
    const date = match[1];
    const time = match[2] || '23:59';
    const start = new Date(`${date}T${time.padStart(5, '0')}:00`);
    return Number.isNaN(start.getTime()) ? null : start;
  }

  function filterExpiredServiceRequests() {
    const list = document.querySelector('.request-list');
    if (!list || list.dataset.currentFilterApplied === 'true') return;
    list.dataset.currentFilterApplied = 'true';

    const now = new Date();
    const cards = [...list.querySelectorAll('.request-card')];
    let visibleCount = 0;

    cards.forEach((card) => {
      const requestStart = parseRequestStart(card);
      const isExpired = requestStart ? requestStart < now : false;
      card.hidden = isExpired;
      card.dataset.expiredServiceRequest = isExpired ? 'true' : 'false';
      if (!isExpired) visibleCount += 1;
    });

    if (!visibleCount) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No hay solicitudes vigentes para asignar.</strong>Solo se muestran servicios cuya fecha y hora aún no han pasado.';
      list.appendChild(empty);
      return;
    }

    const activeCard = list.querySelector('.request-card.active');
    if (activeCard?.hidden) {
      const firstVisible = cards.find((card) => !card.hidden);
      const selectLink = firstVisible?.querySelector('.request-actions a[href*="serviceRequestId="]');
      if (selectLink?.href) window.location.replace(selectLink.href);
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
