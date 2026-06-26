(() => {
  function formatTimeAmPm(value) {
    const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return String(value || '').trim();
    let hour = Number(match[1]);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${match[2]} ${suffix}`;
  }

  function normalizeAssignmentStartTimes(root = document) {
    root.querySelectorAll?.('.assigned-card[data-start]')?.forEach((card) => {
      const current = String(card.dataset.start || '').trim();
      const formatted = formatTimeAmPm(current);
      if (!formatted || formatted === current) return;
      card.dataset.start = formatted;
      card.querySelector('.assignment-message')?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function boot() {
    normalizeAssignmentStartTimes();
    const observer = new MutationObserver(() => normalizeAssignmentStartTimes());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
