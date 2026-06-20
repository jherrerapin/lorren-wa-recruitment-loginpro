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

  function boot() {
    normalizeTimeDataAttributes();
    formatVisibleTimes();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) formatTextNode(node);
          if (node.nodeType === Node.ELEMENT_NODE) {
            normalizeTimeDataAttributes(node);
            formatVisibleTimes(node);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.LoginProTimeFormat = { formatTimeAmPm, formatTimeText, formatVisibleTimes };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
