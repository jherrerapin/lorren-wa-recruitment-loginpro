'use strict';

(() => {
  function manualForms(root = document) {
    return [...(root.querySelectorAll?.('form[action$="/manual"]') || [])];
  }

  function createDateTimeField(name, labelText) {
    const field = document.createElement('div');
    field.className = 'field';

    const label = document.createElement('label');
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.name = name;

    field.append(label, input);
    return { field, input };
  }

  function installManualWorkdayControls(form) {
    if (!form || form.dataset.manualWorkdayControls === 'true') return;
    form.dataset.manualWorkdayControls = 'true';

    form.querySelector('input[name="reason"]')?.remove();

    const breakToggle = document.createElement('label');
    breakToggle.style.cssText = 'display:flex;align-items:flex-start;gap:9px;padding:11px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:12px;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'breakTaken';
    checkbox.value = 'true';
    checkbox.style.width = 'auto';
    checkbox.style.marginTop = '2px';

    const copy = document.createElement('span');
    copy.innerHTML = '<strong>Tomó almuerzo</strong><br/>Activa esta opción para registrar el tiempo real de almuerzo.';
    breakToggle.append(checkbox, copy);

    const breakFields = document.createElement('div');
    breakFields.hidden = true;
    breakFields.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;';
    const start = createDateTimeField('breakStartAt', 'Inicio de almuerzo');
    const end = createDateTimeField('breakEndAt', 'Fin de almuerzo');
    breakFields.append(start.field, end.field);

    const sync = () => {
      breakFields.hidden = !checkbox.checked;
      start.input.required = checkbox.checked;
      end.input.required = checkbox.checked;
      start.input.disabled = !checkbox.checked;
      end.input.disabled = !checkbox.checked;
      if (!checkbox.checked) {
        start.input.value = '';
        end.input.value = '';
      }
    };

    checkbox.addEventListener('change', sync);
    sync();

    const submit = form.querySelector('button[type="submit"], button:not([type])');
    if (submit) form.insertBefore(breakToggle, submit);
    else form.appendChild(breakToggle);
    if (submit) form.insertBefore(breakFields, submit);
    else form.appendChild(breakFields);
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
