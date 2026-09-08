'use strict';

(() => {
  const STYLE_ID = 'candidate-export-date-range-style';
  const EXPORT_LINK_SELECTOR = 'a[href^="/admin/export?"]';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .candidate-export-date-range{display:flex;flex:1 1 100%;width:100%;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:0 0 10px;margin:0 0 2px;border-bottom:1px solid #e1e4e8}
      .candidate-export-date-range-title{font-size:12px;font-weight:700;color:#475569;align-self:center;margin-right:2px}
      .candidate-export-date-field{display:flex;flex-direction:column;gap:4px}
      .candidate-export-date-field label{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
      .candidate-export-date-field input{border:1px solid #e1e4e8;border-radius:6px;padding:6px 9px;font:inherit;font-size:12px;color:#1a1d23;background:#fff;min-height:34px}
      .candidate-export-date-field input:focus{outline:2px solid rgba(13,122,107,.18);border-color:#0d7a6b}
      .candidate-export-date-error{flex:1 1 100%;font-size:12px;font-weight:600;color:#b91c1c}
      .candidate-export-date-error[hidden]{display:none}
      @media(max-width:768px){
        .candidate-export-date-range{align-items:stretch;gap:8px}
        .candidate-export-date-range-title{width:100%;align-self:auto}
        .candidate-export-date-field{flex:1 1 140px}
        .candidate-export-date-field input{width:100%;min-height:40px}
      }
    `;
    document.head.appendChild(style);
  }

  function buildDateField(labelText, inputName) {
    const field = document.createElement('div');
    field.className = 'candidate-export-date-field';

    const label = document.createElement('label');
    const input = document.createElement('input');
    const inputId = `${inputName}-${Math.random().toString(36).slice(2, 9)}`;

    label.htmlFor = inputId;
    label.textContent = labelText;
    input.id = inputId;
    input.type = 'date';
    input.name = inputName;
    input.autocomplete = 'off';

    field.append(label, input);
    return { field, input };
  }

  function installExportRange(bar) {
    if (!bar || bar.dataset.exportDateRangeReady === 'true') return;
    const exportLinks = [...bar.querySelectorAll(EXPORT_LINK_SELECTOR)];
    if (!exportLinks.length) return;

    bar.dataset.exportDateRangeReady = 'true';

    const controls = document.createElement('div');
    controls.className = 'candidate-export-date-range';
    controls.dataset.exportDateRange = 'true';

    const title = document.createElement('span');
    title.className = 'candidate-export-date-range-title';
    title.textContent = 'Rango de fecha de registro';

    const fromField = buildDateField('Desde', 'dateFrom');
    const toField = buildDateField('Hasta', 'dateTo');
    const error = document.createElement('span');
    error.className = 'candidate-export-date-error';
    error.setAttribute('role', 'status');
    error.hidden = true;

    const clearError = () => {
      error.hidden = true;
      error.textContent = '';
    };

    fromField.input.addEventListener('change', () => {
      toField.input.min = fromField.input.value || '';
      clearError();
    });
    toField.input.addEventListener('change', () => {
      fromField.input.max = toField.input.value || '';
      clearError();
    });

    controls.append(title, fromField.field, toField.field, error);
    bar.prepend(controls);

    exportLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        clearError();
        const dateFrom = fromField.input.value;
        const dateTo = toField.input.value;

        if (dateFrom && dateTo && dateFrom > dateTo) {
          event.preventDefault();
          error.textContent = 'La fecha inicial no puede ser posterior a la fecha final.';
          error.hidden = false;
          fromField.input.focus();
          return;
        }

        const url = new URL(link.getAttribute('href'), window.location.origin);
        if (dateFrom) url.searchParams.set('dateFrom', dateFrom);
        else url.searchParams.delete('dateFrom');
        if (dateTo) url.searchParams.set('dateTo', dateTo);
        else url.searchParams.delete('dateTo');
        link.href = `${url.pathname}${url.search}${url.hash}`;
      });
    });
  }

  function install() {
    if (window.location.pathname !== '/admin') return;
    injectStyles();
    document.querySelectorAll('[data-vacancy-panel] .export-bar').forEach(installExportRange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
