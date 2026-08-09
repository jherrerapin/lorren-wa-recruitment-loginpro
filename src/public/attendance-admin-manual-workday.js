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
    const toggleCopy = checkbox?.closest('.manual-break-toggle')?.querySelector('span');
    if (!checkbox || !breakFields || !startInput || !endInput) return;

    form.dataset.manualWorkdayControls = 'true';

    const sync = () => {
      const breakTaken = checkbox.checked;
      breakFields.hidden = !breakTaken;
      startInput.required = breakTaken;
      endInput.required = breakTaken;
      startInput.disabled = !breakTaken;
      endInput.disabled = !breakTaken;
      checkbox.setAttribute('aria-expanded', String(breakTaken));

      if (toggleCopy) {
        toggleCopy.innerHTML = breakTaken
          ? '<strong>Tomó almuerzo: sí</strong><br/>Registra la hora de inicio y la hora de fin.'
          : '<strong>Tomó almuerzo: no</strong><br/>Márcalo solo si realmente hubo almuerzo.';
      }

      if (!breakTaken) {
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
