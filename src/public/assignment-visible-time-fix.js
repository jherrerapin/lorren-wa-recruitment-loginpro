(() => {
  const pattern = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);

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
    return String(text || '').replace(pattern, (_value, hour, minutes) => formatTimeAmPm(`${hour}:${minutes}`));
  }

  function shouldFormatNode(node) {
    const parent = node?.parentElement;
    if (!parent) return false;
    if (skipTags.has(parent.tagName)) return false;
    if (parent.closest('[data-keep-military-time="true"]')) return false;
    return true;
  }

  function formatVisibleTimes(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (!shouldFormatNode(node)) return;
      const current = node.nodeValue || '';
      const formatted = formatTimeText(current);
      if (formatted !== current) node.nodeValue = formatted;
    });
  }

  function formatDataAttributes(root = document.body) {
    root.querySelectorAll?.('[data-start], [data-end], [data-start-time], [data-end-time]').forEach((element) => {
      ['start', 'end', 'startTime', 'endTime'].forEach((key) => {
        if (!element.dataset || !(key in element.dataset)) return;
        const formatted = formatTimeAmPm(element.dataset[key]);
        if (formatted) element.dataset[key] = formatted;
      });
    });
  }

  function run(root = document.body) {
    formatDataAttributes(root);
    formatVisibleTimes(root);
    if (typeof window.refreshWhatsappLinks === 'function') window.refreshWhatsappLinks();
  }

  function boot() {
    run();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) run(node);
          if (node.nodeType === Node.TEXT_NODE && shouldFormatNode(node)) {
            const formatted = formatTimeText(node.nodeValue || '');
            if (formatted !== node.nodeValue) node.nodeValue = formatted;
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.LoginProTimeFormat = { ...(window.LoginProTimeFormat || {}), formatTimeAmPm, formatTimeText, formatVisibleTimes: run };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
