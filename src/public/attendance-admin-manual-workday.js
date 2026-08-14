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
    const toggleLabel = checkbox?.closest('.manual-break-toggle');
    const toggleCopy = toggleLabel?.querySelector('span');
    if (!checkbox || !breakFields || !startInput || !endInput) return;

    form.dataset.manualWorkdayControls = 'true';

    checkbox.style.width = '18px';
    checkbox.style.height = '18px';
    checkbox.style.minWidth = '18px';
    checkbox.style.padding = '0';
    checkbox.style.flex = '0 0 18px';
    checkbox.style.accentColor = '#0d7a6b';
    checkbox.style.cursor = 'pointer';
    if (toggleLabel) toggleLabel.style.cursor = 'pointer';

    const sync = () => {
      const breakTaken = checkbox.checked;
      breakFields.hidden = !breakTaken;
      breakFields.style.display = breakTaken ? 'grid' : 'none';
      startInput.required = breakTaken;
      endInput.required = breakTaken;
      startInput.disabled = !breakTaken;
      endInput.disabled = !breakTaken;
      checkbox.setAttribute('aria-expanded', String(breakTaken));

      if (toggleLabel) {
        toggleLabel.style.borderColor = breakTaken ? '#0d7a6b' : '#bfdbfe';
        toggleLabel.style.background = breakTaken ? '#ecfdf5' : '#eff6ff';
        toggleLabel.style.color = breakTaken ? '#065f46' : '#1e40af';
      }

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
