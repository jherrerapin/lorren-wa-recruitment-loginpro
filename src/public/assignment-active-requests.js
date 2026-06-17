(() => {
  function getBogotaParts() {
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
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`
    };
  }

  function parseRequestSchedule(card) {
    const text = card.textContent || '';
    const match = text.match(/(20\d{2}-\d{2}-\d{2})\s*·\s*(\d{2}:\d{2})?/);
    return {
      date: match?.[1] || '',
      startTime: match?.[2] || ''
    };
  }

  function isCurrentOrFutureRequest(card, now) {
    const schedule = parseRequestSchedule(card);
    if (!schedule.date) return true;
    if (schedule.date > now.date) return true;
    if (schedule.date < now.date) return false;
    if (!schedule.startTime) return true;
    return schedule.startTime >= now.time;
  }

  function showEmptyNotice(list) {
    if (!list || document.getElementById('activeRequestsEmptyNotice')) return;
    const notice = document.createElement('div');
    notice.id = 'activeRequestsEmptyNotice';
    notice.className = 'empty';
    notice.innerHTML = '<strong>No hay solicitudes vigentes para asignar.</strong>Solo se muestran servicios futuros o de hoy que aún no han iniciado.';
    list.prepend(notice);
  }

  function filterActiveRequests() {
    const list = document.querySelector('.request-list');
    if (!list) return;
    const cards = Array.from(list.querySelectorAll('.request-card'));
    if (!cards.length) return;
    const now = getBogotaParts();
    let visibleCount = 0;
    let selectedExpired = false;

    cards.forEach((card) => {
      const isActive = isCurrentOrFutureRequest(card, now);
      const isSelected = card.classList.contains('active');
      card.hidden = !isActive;
      if (isActive) visibleCount += 1;
      if (!isActive && isSelected) selectedExpired = true;
    });

    if (!visibleCount) showEmptyNotice(list);

    if (selectedExpired && visibleCount > 0) {
      const firstVisibleLink = cards.find((card) => !card.hidden)?.querySelector('a[href*="serviceRequestId="]');
      if (firstVisibleLink?.href) window.location.replace(firstVisibleLink.href);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', filterActiveRequests);
  else filterActiveRequests();
})();
