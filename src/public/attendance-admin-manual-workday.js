'use strict';

(() => {
  function manualForms(root = document) {
    return [...(root.querySelectorAll?.('form[data-manual-workday-form="true"]') || [])];
  }

  function installManualWorkdayControls(form) {
    if (!form || form.dataset.manualWorkdayControls === 'true') return;

    const checkbox = form.querySelector('[data-manual-break-toggle]');
    const breakFields = form.querySelector('[data-manual-break-fields]');
    const startInput = form.querySelector('[data-manual-break-start]');
    const endInput = form.querySelector('[data-manual-break-end]');
    if (!checkbox || !breakFields || !startInput || !endInput) return;

    form.dataset.manualWorkdayControls = 'true';

    const sync = () => {
      breakFields.hidden = !checkbox.checked;
      startInput.required = checkbox.checked;
      endInput.required = checkbox.checked;
      startInput.disabled = !checkbox.checked;
      endInput.disabled = !checkbox.checked;
      if (!checkbox.checked) {
        startInput.value = '';
        endInput.value = '';
      }
    };

    checkbox.addEventListener('change', sync);
    sync();
  }

  function initialize() {
    manualForms().forEach(installManualWorkdayControls);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
