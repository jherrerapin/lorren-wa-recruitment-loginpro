(() => {
  function parseTimeToMinutes(value) {
    const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return hours * 60 + minutes;
  }

  function todayBogotaDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function currentBogotaMinutes() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Bogota',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(values.hour) * 60 + Number(values.minute);
  }

  function parseRequestDateAndStart(card) {
    const text = card.textContent || '';
    const dateMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
    const timeMatch = text.match(/\b\d{1,2}:\d{2}\b/);
    return {
      date: dateMatch ? dateMatch[0] : '',
      startMinutes: timeMatch ? parseTimeToMinutes(timeMatch[0]) : null
    };
  }

  function isCurrentOrFutureRequest(card, today, nowMinutes) {
    const { date, startMinutes } = parseRequestDateAndStart(card);
    if (!date) return true;
    if (date > today) return true;
    if (date < today) return false;
    if (startMinutes === null) return true;
    return startMinutes >= nowMinutes;
  }

  function filterActiveRequests() {
    const requestList = document.querySelector('.request-list');
    if (!requestList || requestList.dataset.activeFiltered === 'true') return;
    requestList.dataset.activeFiltered = 'true';
    const cards = Array.from(requestList.querySelectorAll('.request-card'));
    if (!cards.length) return;

    const today = todayBogotaDate();
    const nowMinutes = currentBogotaMinutes();
    let visibleCount = 0;
    let activeCardStillVisible = false;

    cards.forEach((card) => {
      const visible = isCurrentOrFutureRequest(card, today, nowMinutes);
      card.hidden = !visible;
      if (visible) visibleCount += 1;
      if (visible && card.classList.contains('active')) activeCardStillVisible = true;
    });

    if (!visibleCount) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<strong>No hay solicitudes vigentes.</strong>Cuando existan servicios futuros o pendientes para hoy, aparecerán aquí.';
      requestList.appendChild(empty);
    }

    const selectedSummary = document.getElementById('selectedRequestSummary');
    const assignmentBody = selectedSummary?.closest('.assignment-body');
    if (assignmentBody && selectedSummary && !activeCardStillVisible) {
      assignmentBody.innerHTML = '<div class="empty"><strong>Selecciona una solicitud vigente.</strong>Las solicitudes de días anteriores o de horarios ya vencidos se ocultan para evitar asignaciones por error.</div>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', filterActiveRequests);
  else filterActiveRequests();
})();
