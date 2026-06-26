(() => {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g;

  function formatTimeAmPm(value) {
    const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return String(value || '').trim();
    let hour = Number(match[1]);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${match[2]} ${suffix}`;
  }

  function formatText(value) {
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
      const next = formatText(current);
      if (next !== current) node.nodeValue = next;
    });
  }

  function selectedDateParam() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('fecha') || params.get('date') || '';
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  }

  function requestDate(card) {
    return [...card.querySelectorAll('.meta span')].map((span) => span.textContent || '').join(' ').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  }

  function requestStart(card) {
    const text = [...card.querySelectorAll('.meta span')].map((span) => span.textContent || '').find((item) => /\d{4}-\d{2}-\d{2}/.test(item));
    const match = text?.match(/(\d{4}-\d{2}-\d{2})\s*·\s*([0-2]?\d:[0-5]\d|[0-2]?\d:[0-5]\d\s*(?:AM|PM))?/i);
    if (!match) return null;
    let time = match[2] || '23:59';
    if (/am|pm/i.test(time)) {
      const p = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (p) {
        let hour = Number(p[1]);
        if (p[3].toUpperCase() === 'PM' && hour < 12) hour += 12;
        if (p[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
        time = `${String(hour).padStart(2, '0')}:${p[2]}`;
      }
    }
    const start = new Date(`${match[1]}T${String(time).padStart(5, '0')}:00-05:00`);
    return Number.isNaN(start.getTime()) ? null : start;
  }

  function preserveDateOnSelectionLinks() {
    const date = selectedDateParam();
    document.querySelectorAll('.request-card a[href*="/admin/operaciones/asignaciones?serviceRequestId="]').forEach((link) => {
      const url = new URL(link.href, window.location.origin);
      if (date) url.searchParams.set('fecha', date);
      link.href = `${url.pathname}${url.search}`;
    });
  }

  function hideExpiredWithoutDate() {
    const list = document.querySelector('.request-list');
    if (!list || selectedDateParam()) return;
    const now = Date.now();
    let hidden = 0;
    list.querySelectorAll('.request-card').forEach((card) => {
      const start = requestStart(card);
      const expired = start ? now > start.getTime() + TWO_HOURS_MS : false;
      card.hidden = expired;
      card.dataset.expiredServiceRequest = expired ? 'true' : 'false';
      if (expired) hidden += 1;
    });
    const head = list.closest('.board-panel')?.querySelector('.board-panel-head p');
    if (head && hidden) head.textContent = `Solo se muestran solicitudes vigentes. ${hidden} solicitud(es) con más de 2 horas posteriores al servicio ocultas.`;
  }

  function removeDuplicatedDateFilters() {
    const forms = [...document.querySelectorAll('#assignmentDateFilter, #assignmentDateFilterForm')];
    forms.slice(1).forEach((form) => form.remove());
  }

  function addRequestCrudActions() {
    document.querySelectorAll('.request-card').forEach((card) => {
      const edit = card.querySelector('a[href*="/asignaciones/solicitudes/"][href$="/editar"]');
      const actions = card.querySelector('.request-actions');
      if (!edit || !actions || actions.querySelector('[data-delete-service-request="true"]')) return;
      const start = requestStart(card);
      const locked = start ? Date.now() > start.getTime() + TWO_HOURS_MS : false;
      if (locked) return;
      const match = edit.href.match(/solicitudes\/([^/]+)\/editar/);
      if (!match) return;
      const form = document.createElement('form');
      form.method = 'post';
      form.action = `/admin/operaciones/solicitudes/${match[1]}/eliminar`;
      form.dataset.deleteServiceRequest = 'true';
      form.innerHTML = '<button class="btn" type="submit">Eliminar</button>';
      form.addEventListener('submit', (event) => {
        if (!confirm('¿Eliminar esta solicitud de servicio?')) event.preventDefault();
      });
      actions.appendChild(form);
    });
  }

  function boot() {
    formatVisibleTimes();
    preserveDateOnSelectionLinks();
    hideExpiredWithoutDate();
    removeDuplicatedDateFilters();
    addRequestCrudActions();
    const observer = new MutationObserver(() => {
      formatVisibleTimes();
      removeDuplicatedDateFilters();
      addRequestCrudActions();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.LoginProTimeFormat = { ...(window.LoginProTimeFormat || {}), formatTimeAmPm, formatVisibleTimes };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
