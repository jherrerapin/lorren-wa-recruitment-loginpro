(() => {
  const TIME_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);

  function formatTimeAmPm(value) {
    const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return String(value || '').trim();
    let hour = Number(match[1]);
    const minutes = match[2];
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour %= 12;
    if (hour === 0) hour = 12;
    return `${hour}:${minutes} ${suffix}`;
  }

  function formatTimeText(text) {
    return String(text || '').replace(TIME_PATTERN, (_value, hour, minutes) => formatTimeAmPm(`${hour}:${minutes}`));
  }

  function shouldSkipNode(node) {
    const parent = node?.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest('[data-keep-military-time="true"]')) return true;
    return false;
  }

  function formatTextNode(node) {
    if (shouldSkipNode(node)) return;
    const current = node.nodeValue || '';
    const formatted = formatTimeText(current);
    if (formatted !== current) node.nodeValue = formatted;
  }

  function formatVisibleTimes(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(formatTextNode);
  }

  function normalizeTimeDataAttributes(root = document.body) {
    root.querySelectorAll?.('[data-start], [data-end], [data-start-time], [data-end-time]').forEach((element) => {
      ['start', 'end', 'startTime', 'endTime'].forEach((key) => {
        if (!element.dataset || !(key in element.dataset)) return;
        const formatted = formatTimeAmPm(element.dataset[key]);
        if (formatted) element.dataset[key] = formatted;
      });
    });
  }

  function getSelectedDate() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('fecha');
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromUrl || '')) return fromUrl;
    const dateInput = document.querySelector('input[name="fecha"], input[type="date"]');
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput?.value || '')) return dateInput.value;
    return new Date().toISOString().slice(0, 10);
  }

  function normalizeAllRequestsLinks(root = document.body) {
    root.querySelectorAll?.('a[href="/admin/operaciones/solicitudes"]').forEach((link) => {
      const label = String(link.textContent || '').trim().toLowerCase();
      if (!label.includes('solicitudes')) return;
      const target = `/admin/operaciones/solicitudes/resumen?fecha=${encodeURIComponent(getSelectedDate())}&tipo=total`;
      link.setAttribute('href', target);
    });
  }

  function boot() {
    normalizeTimeDataAttributes();
    formatVisibleTimes();
    normalizeAllRequestsLinks();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) formatTextNode(node);
          if (node.nodeType === Node.ELEMENT_NODE) {
            normalizeTimeDataAttributes(node);
            formatVisibleTimes(node);
            normalizeAllRequestsLinks(node);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.LoginProTimeFormat = { formatTimeAmPm, formatTimeText, formatVisibleTimes, normalizeAllRequestsLinks };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
