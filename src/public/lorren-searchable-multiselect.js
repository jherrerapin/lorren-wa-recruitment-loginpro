'use strict';

(() => {
  const STYLE_ID = 'lorren-searchable-multiselect-style';
  const MIN_QUERY_LENGTH = 3;

  function fold(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('es-CO')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .lorren-search-multiselect{position:relative;display:grid;gap:6px;min-width:0}
      .lorren-search-multiselect-input{width:100%;min-width:0}
      .lorren-search-multiselect-panel{display:grid;gap:4px;max-height:280px;overflow:auto;margin-top:4px;padding:6px;border:1px solid #d7dee8;border-radius:10px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.12)}
      .lorren-search-multiselect-panel[hidden]{display:none!important}
      .lorren-search-multiselect-option{display:flex!important;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;cursor:pointer;font-size:12px!important;font-weight:500!important}
      .lorren-search-multiselect-option:hover{background:#eef8f6}
      .lorren-search-multiselect-option input{width:16px!important;min-width:16px;height:16px;margin:1px 0 0;padding:0;flex:0 0 auto;accent-color:var(--teal,#0d7a6b)}
      .lorren-search-multiselect-option span{min-width:0;overflow-wrap:anywhere}
      .lorren-search-multiselect-meta{display:block;margin-top:2px;color:#64748b;font-size:10px;line-height:1.3}
      .lorren-search-multiselect-help{padding:6px 8px;color:#64748b;font-size:10px;line-height:1.35}
      .lorren-search-multiselect-selected{display:flex;gap:6px;flex-wrap:wrap;min-height:0}
      .lorren-search-multiselect-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:4px 7px;border-radius:999px;background:#eef8f6;color:#0d5f54;font-size:10px;font-weight:800}
      .lorren-search-multiselect-chip button{border:0;background:transparent;color:inherit;padding:0;cursor:pointer;font:inherit;font-size:12px;line-height:1}
      @media(max-width:700px){.lorren-search-multiselect-panel{max-height:240px}.lorren-search-multiselect-option{min-height:42px}}
    `;
    document.head.appendChild(style);
  }

  function createChipHost(field) {
    let host = field.querySelector('[data-lorren-search-selected]');
    if (host) return host;
    host = document.createElement('div');
    host.className = 'lorren-search-multiselect-selected';
    host.dataset.lorrenSearchSelected = 'true';
    field.appendChild(host);
    return host;
  }

  function searchableCheckboxMultiSelect({
    field,
    input,
    options,
    getValue,
    getLabel,
    getMeta,
    isChecked,
    setChecked,
    onSelectionChange,
    emptyLabel = 'No hay coincidencias.',
    shortQueryLabel = `Escribe al menos ${MIN_QUERY_LENGTH} caracteres para buscar.`
  }) {
    if (!field || !input || input.dataset.lorrenSearchMultiSelect === 'true') return null;
    input.dataset.lorrenSearchMultiSelect = 'true';
    input.classList.add('lorren-search-multiselect-input');
    input.setAttribute('autocomplete', 'off');

    const wrapper = document.createElement('div');
    wrapper.className = 'lorren-search-multiselect';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const selectedHost = createChipHost(wrapper);
    const panel = document.createElement('div');
    panel.className = 'lorren-search-multiselect-panel';
    panel.hidden = true;
    wrapper.appendChild(panel);

    const sourceOptions = Array.from(options || []);
    const selectedOptions = () => sourceOptions.filter((option) => isChecked(option));

    const optionRow = (option) => {
      const row = document.createElement('label');
      row.className = 'lorren-search-multiselect-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isChecked(option);
      checkbox.value = getValue(option);
      checkbox.addEventListener('change', () => {
        setChecked(option, checkbox.checked);
        renderSelected();
        onSelectionChange?.();
      });
      const copy = document.createElement('span');
      copy.textContent = getLabel(option);
      const meta = getMeta(option);
      if (meta) {
        const small = document.createElement('small');
        small.className = 'lorren-search-multiselect-meta';
        small.textContent = meta;
        copy.appendChild(small);
      }
      row.append(checkbox, copy);
      return row;
    };

    const renderSelected = () => {
      selectedHost.replaceChildren();
      selectedOptions().forEach((option) => {
        const chip = document.createElement('span');
        chip.className = 'lorren-search-multiselect-chip';
        const text = document.createElement('span');
        text.textContent = getLabel(option);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Quitar ${getLabel(option)}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          setChecked(option, false);
          renderSelected();
          renderResults();
          onSelectionChange?.();
        });
        chip.append(text, remove);
        selectedHost.appendChild(chip);
      });
    };

    const renderResults = () => {
      const query = fold(input.value);
      const selected = selectedOptions();
      const matches = query.length >= MIN_QUERY_LENGTH
        ? sourceOptions.filter((option) => fold(`${getLabel(option)} ${getMeta(option) || ''}`).includes(query))
        : selected;

      panel.replaceChildren();
      if (!matches.length) {
        const help = document.createElement('div');
        help.className = 'lorren-search-multiselect-help';
        help.textContent = query.length < MIN_QUERY_LENGTH ? shortQueryLabel : emptyLabel;
        panel.appendChild(help);
        panel.hidden = false;
        return;
      }
      matches.forEach((option) => panel.appendChild(optionRow(option)));
      panel.hidden = false;
    };

    input.addEventListener('input', renderResults);
    input.addEventListener('focus', renderResults);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') panel.hidden = true;
    });
    document.addEventListener('pointerdown', (event) => {
      if (!wrapper.contains(event.target)) panel.hidden = true;
    });

    renderSelected();
    return { renderSelected, renderResults, selectedOptions };
  }

  function attendanceOption(card) {
    const name = card.querySelector('.summary-name')?.textContent?.trim() || 'Auxiliar';
    const documentText = card.querySelector('.summary-main > div:first-child .summary-secondary')?.textContent?.trim() || '';
    const operation = card.querySelector('.summary-identity strong')?.textContent?.trim() || '';
    const city = card.querySelector('.summary-identity .summary-secondary')?.textContent?.trim() || '';
    return {
      card,
      key: fold(`${name}|${documentText}`),
      value: `${name}|${documentText}`,
      label: name,
      meta: [documentText, operation, city].filter(Boolean).join(' · '),
      checked: false
    };
  }

  function installAttendanceMultiSelect() {
    const form = document.querySelector('.filter-card form[method="get"]');
    const input = form?.querySelector('input[name="q"]');
    const field = input?.closest('.field');
    if (!form || !input || !field || field.dataset.attendanceSearchMultiselect === 'true') return;

    const cards = [...document.querySelectorAll('[data-attendance-card]')];
    if (!cards.length) return;

    const label = field.querySelector('label');
    if (label) label.textContent = 'Auxiliares';
    input.placeholder = 'Busca por nombre, documento, punto o sucursal';
    input.removeAttribute('name');
    input.value = '';
    field.dataset.attendanceSearchMultiselect = 'true';

    const byKey = new Map();
    cards.forEach((card) => {
      const option = attendanceOption(card);
      if (!byKey.has(option.key)) byKey.set(option.key, option);
    });
    const options = [...byKey.values()];

    const applySelection = () => {
      const selectedKeys = new Set(options.filter((option) => option.checked).map((option) => option.key));
      cards.forEach((card) => {
        const option = attendanceOption(card);
        card.hidden = selectedKeys.size > 0 && !selectedKeys.has(option.key);
      });
      const counter = document.querySelector('.attendance-list-tools strong');
      if (counter) counter.textContent = `${cards.filter((card) => !card.hidden).length} auxiliar(es)`;
    };

    searchableCheckboxMultiSelect({
      field,
      input,
      options,
      getValue: (option) => option.value,
      getLabel: (option) => option.label,
      getMeta: (option) => option.meta,
      isChecked: (option) => option.checked,
      setChecked: (option, checked) => { option.checked = checked; },
      onSelectionChange: applySelection
    });
  }

  function installPayrollMultiSelect() {
    const form = document.getElementById('payroll-filters');
    const picker = form?.querySelector('.worker-picker');
    const menu = picker?.querySelector('.worker-picker-menu');
    const searchInput = form?.querySelector('input[name="search"]');
    const searchField = searchInput?.closest('.field');
    if (!form || !picker || !menu || !searchInput || !searchField) return;

    const options = [...menu.querySelectorAll('.worker-check')].map((label) => ({
      label,
      input: label.querySelector('input[name="workerId"]'),
      copy: label.querySelector('span')?.textContent?.replace(/\s+/g, ' ')?.trim() || ''
    })).filter((option) => option.input);
    if (!options.length) return;

    const summary = picker.querySelector('summary');
    const refreshSummary = () => {
      const count = options.filter((option) => option.input.checked).length;
      if (summary) summary.textContent = count ? `${count} auxiliar(es) seleccionado(s)` : 'Todos los auxiliares';
    };

    searchInput.removeAttribute('name');
    searchInput.value = '';
    searchInput.placeholder = 'Busca por nombre o documento';
    searchInput.classList.add('lorren-search-multiselect-input');
    menu.prepend(searchInput);
    searchField.remove();

    const help = menu.querySelector('.worker-picker-help');
    if (help) help.textContent = `Escribe al menos ${MIN_QUERY_LENGTH} caracteres y marca uno o varios auxiliares. Si no marcas ninguno, se analizan todos.`;

    const filterOptions = () => {
      const query = fold(searchInput.value);
      options.forEach((option) => {
        option.label.hidden = !(option.input.checked || (query.length >= MIN_QUERY_LENGTH && fold(option.copy).includes(query)));
      });
    };

    searchInput.addEventListener('input', filterOptions);
    options.forEach((option) => option.input.addEventListener('change', () => {
      refreshSummary();
      filterOptions();
    }));
    refreshSummary();
    filterOptions();
  }

  function install() {
    injectStyles();
    installAttendanceMultiSelect();
    installPayrollMultiSelect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
