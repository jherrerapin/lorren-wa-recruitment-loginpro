'use strict';

(() => {
  const STYLE_ID = 'candidate-export-date-range-style';
  const EXPORT_LINK_SELECTOR = 'a[href^="/admin/export?"], a[href^="/admin/export-global?"]';
  const MONTH_FORMATTER = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' });
  const RANGE_DATE_FORMATTER = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const TAB_EXPORT_SCOPE = Object.freeze({
    registered: 'registered',
    'missing-cv': 'missing_cv_complete',
    approved: 'approved',
    contacted: 'contacted',
    contracted: 'contracted',
    rejected: 'rejected'
  });
  const TAB_EXPORT_LABEL = Object.freeze({
    registered: 'registrados',
    'missing-cv': 'completos sin HV',
    approved: 'aprobados',
    contacted: 'contactados',
    contracted: 'contratados',
    rejected: 'rechazados'
  });
  const GLOBAL_EXPORT_LABEL = Object.freeze({
    registered: 'registrados',
    missing_cv_complete: 'pendientes HV',
    approved: 'aprobados',
    contacted: 'contactados',
    contracted: 'contratados',
    rejected: 'rechazados',
    all: 'todos'
  });

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .candidate-export-date-range{position:relative;display:flex;flex:1 1 100%;width:100%;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 10px;margin:0 0 2px;border-bottom:1px solid #e1e4e8}
      .candidate-export-date-range-title{font-size:12px;font-weight:700;color:#475569}
      .candidate-export-range-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:12px;min-width:250px;min-height:36px;padding:7px 10px;border:1px solid #e1e4e8;border-radius:7px;background:#fff;color:#1a1d23;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:left}
      .candidate-export-range-trigger:hover{background:#f8fafc;border-color:#cbd5e1}
      .candidate-export-range-trigger:focus-visible{outline:2px solid rgba(13,122,107,.24);border-color:#0d7a6b}
      .candidate-export-range-trigger-icon{color:#0d7a6b;font-size:14px}
      .candidate-export-range-popover{position:absolute;z-index:1300;left:0;top:calc(100% + 6px);width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 24px);overflow:auto;padding:12px;border:1px solid #d7dee8;border-radius:10px;background:#fff;box-shadow:0 16px 36px rgba(15,23,42,.18)}
      .candidate-export-range-popover.is-above{top:auto;bottom:calc(100% + 6px)}
      .candidate-export-range-popover[hidden]{display:none!important}
      .candidate-export-range-header{display:grid;grid-template-columns:36px 1fr 36px;align-items:center;gap:6px;margin-bottom:10px}
      .candidate-export-range-month{font-size:13px;font-weight:800;color:#1e2d3d;text-align:center;text-transform:capitalize}
      .candidate-export-range-nav{width:36px;height:34px;border:1px solid #e1e4e8;border-radius:7px;background:#fff;color:#475569;font-size:16px;cursor:pointer}
      .candidate-export-range-nav:hover{background:#f3f4f6;color:#1e2d3d}
      .candidate-export-range-weekdays,.candidate-export-range-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
      .candidate-export-range-weekdays{margin-bottom:3px}
      .candidate-export-range-weekday{font-size:10px;font-weight:800;color:#94a3b8;text-align:center;padding:3px 0}
      .candidate-export-range-day{aspect-ratio:1;border:0;border-radius:7px;background:transparent;color:#334155;font:inherit;font-size:12px;cursor:pointer}
      .candidate-export-range-day:hover{background:#e6f4f1;color:#0d5f54}
      .candidate-export-range-day.is-today{box-shadow:inset 0 0 0 1px #0d7a6b}
      .candidate-export-range-day.is-in-range{background:#e6f4f1;border-radius:4px}
      .candidate-export-range-day.is-start,.candidate-export-range-day.is-end{background:#0d7a6b;color:#fff;font-weight:800;border-radius:7px}
      .candidate-export-range-empty{aspect-ratio:1}
      .candidate-export-range-help{margin:9px 2px 0;font-size:11px;line-height:1.4;color:#64748b}
      .candidate-export-range-footer{display:flex;justify-content:flex-end;margin-top:10px;padding-top:9px;border-top:1px solid #edf0f3}
      .candidate-export-range-clear{border:0;background:transparent;color:#0d7a6b;font:inherit;font-size:11px;font-weight:700;cursor:pointer;padding:4px 6px}
      .candidate-export-range-clear:hover{text-decoration:underline}
      @media(max-width:768px){
        .candidate-export-date-range{align-items:stretch;gap:8px}
        .candidate-export-date-range-title{width:100%}
        .candidate-export-range-trigger{width:100%;min-width:0;min-height:42px}
        .candidate-export-range-popover{left:0;right:auto;width:min(360px,calc(100vw - 48px))}
        .candidate-export-range-day{min-height:38px}
      }
    `;
    document.head.appendChild(style);
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function isoDate(year, monthIndex, day) {
    return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
  }

  function dateFromIso(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function validIsoDate(value) {
    const date = dateFromIso(value);
    if (!date) return '';
    return isoDate(date.getFullYear(), date.getMonth(), date.getDate()) === String(value) ? String(value) : '';
  }

  function formatRangeDate(value) {
    const date = dateFromIso(value);
    return date ? RANGE_DATE_FORMATTER.format(date) : '';
  }

  function exportScope(link) {
    try {
      return new URL(link.getAttribute('href') || '', window.location.origin).searchParams.get('scope');
    } catch {
      return null;
    }
  }

  function restoreRangeDecoratedLinks(bar) {
    bar.querySelectorAll(`${EXPORT_LINK_SELECTOR}[data-range-base-href]`).forEach((link) => {
      link.href = link.dataset.rangeBaseHref;
      link.textContent = link.dataset.rangeBaseLabel || link.textContent;
      delete link.dataset.rangeBaseHref;
      delete link.dataset.rangeBaseLabel;
    });
    bar.querySelectorAll(`${EXPORT_LINK_SELECTOR}[data-range-forced-hidden]`).forEach((link) => {
      link.hidden = link.dataset.rangePreviousHidden === 'true';
      delete link.dataset.rangeForcedHidden;
      delete link.dataset.rangePreviousHidden;
    });
  }

  function activeExportContext(panel, bar) {
    if (!panel && bar?.dataset?.globalCandidateExportScope) {
      return {
        key: 'global',
        scope: String(bar.dataset.globalCandidateExportScope || ''),
        label: String(bar.dataset.globalCandidateExportLabel || 'registros')
      };
    }
    const key = String(panel?.dataset?.activeVacancyTab || '');
    const declaredScope = String(panel?.dataset?.activeVacancyExportScope || '');
    return {
      key,
      scope: declaredScope || TAB_EXPORT_SCOPE[key] || '',
      label: TAB_EXPORT_LABEL[key] || key
    };
  }

  function rangeLabel(dateFrom, dateTo) {
    if (!dateFrom) return '';
    if (dateTo) return `${formatRangeDate(dateFrom)} – ${formatRangeDate(dateTo)}`;
    return `desde ${formatRangeDate(dateFrom)}`;
  }

  function updateContextualRangeDownload(bar, panel, dateFrom, dateTo) {
    restoreRangeDecoratedLinks(bar);
    const context = activeExportContext(panel, bar);
    if (!dateFrom || !context.scope) return;

    const links = [...bar.querySelectorAll(EXPORT_LINK_SELECTOR)];
    const scopedLink = links.find((link) => exportScope(link) === context.scope);
    if (!scopedLink) return;

    const baseHref = scopedLink.getAttribute('href') || '';
    const baseLabel = String(scopedLink.textContent || '').trim();
    scopedLink.dataset.rangeBaseHref = baseHref;
    scopedLink.dataset.rangeBaseLabel = baseLabel;

    const url = new URL(baseHref, window.location.origin);
    url.searchParams.set('scope', context.scope);
    url.searchParams.set('dateFrom', dateFrom);
    if (dateTo) url.searchParams.set('dateTo', dateTo);
    else url.searchParams.delete('dateTo');
    scopedLink.href = `${url.pathname}${url.search}${url.hash}`;
    scopedLink.textContent = `↓ Descargar ${context.label} · ${rangeLabel(dateFrom, dateTo)}`;
    scopedLink.hidden = false;

    const allLink = links.find((link) => exportScope(link) === 'all');
    if (allLink && allLink !== scopedLink) {
      allLink.dataset.rangeForcedHidden = 'true';
      allLink.dataset.rangePreviousHidden = allLink.hidden ? 'true' : 'false';
      allLink.hidden = true;
    }
  }

  function candidateRegisteredDate(row) {
    const metadata = Array.from(row?.querySelectorAll?.('.candidate-dev-meta') || [])
      .map((node) => String(node.textContent || '').trim())
      .find((text) => /^Fecha de registro:/i.test(text));
    const match = metadata?.match(/Fecha de registro:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (!match) return '';
    return `${match[3]}-${pad(match[2])}-${pad(match[1])}`;
  }

  function rowIsActuallyVisible(row) {
    if (!row || row.hidden) return false;
    const tabPanel = row.closest('.candidate-vacancy-section-panel');
    return !tabPanel || !tabPanel.hidden;
  }

  function historyCheckboxes(panel) {
    return Array.from(panel?.querySelectorAll?.('input[data-history-candidate-id]') || []);
  }

  function notifyCheckboxChange(checkbox) {
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pruneHiddenHistorySelections(panel) {
    historyCheckboxes(panel).forEach((checkbox) => {
      const row = checkbox.closest('.candidate-row, tr');
      if (checkbox.checked && !rowIsActuallyVisible(row)) {
        checkbox.checked = false;
        notifyCheckboxChange(checkbox);
      }
    });
  }

  function filterHistoryRows(panel, dateFrom, dateTo) {
    panel.querySelectorAll('.candidate-row').forEach((row) => {
      const registeredDate = candidateRegisteredDate(row);
      if (!registeredDate) return;
      const inRange = (!dateFrom || registeredDate >= dateFrom)
        && (!dateTo || registeredDate <= dateTo);
      row.hidden = !inRange;
    });
    pruneHiddenHistorySelections(panel);
  }

  function historyIsActive(vacancyId) {
    if (!vacancyId) return false;
    const params = new URL(window.location.href).searchParams;
    return String(params.get(`vh_${vacancyId}`) || '').toLowerCase() === 'all';
  }

  function installHistoryRangeBehavior(controls, panel, vacancyId) {
    if (!panel || !historyIsActive(vacancyId)) return;

    const bulkToolbar = Array.from(panel.querySelectorAll('[data-vacancy-bulk-status]'))
      .find((element) => String(element.getAttribute('data-vacancy-bulk-status') || '') === vacancyId);
    if (bulkToolbar) bulkToolbar.prepend(controls);

    controls.addEventListener('candidate-date-range-change', (event) => {
      const dateFrom = String(event.detail?.dateFrom || '');
      const dateTo = String(event.detail?.dateTo || '');
      filterHistoryRows(panel, dateFrom, dateTo);
    });

    const selectAll = Array.from(panel.querySelectorAll('[data-history-select-all]'))
      .find((element) => String(element.getAttribute('data-history-select-all') || '') === vacancyId);
    selectAll?.addEventListener('change', () => {
      window.setTimeout(() => pruneHiddenHistorySelections(panel), 0);
    });

    panel.addEventListener('click', (event) => {
      if (!event.target.closest('[data-section-tab]')) return;
      window.setTimeout(() => pruneHiddenHistorySelections(panel), 0);
    });
  }

  function setRangeParam(url, key, value) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }

  function setFormRangeInput(form, name, value) {
    let input = form.querySelector(`input[name="${name}"][data-global-range-param]`);
    if (!value) {
      input?.remove();
      return;
    }
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.dataset.globalRangeParam = 'true';
      form.appendChild(input);
    }
    input.value = value;
  }

  function syncGlobalRangeNavigation(bar, dateFrom, dateTo) {
    if (bar.dataset.globalCandidateExport !== 'true') return;

    const current = new URL(window.location.href);
    setRangeParam(current, 'dateFrom', dateFrom);
    setRangeParam(current, 'dateTo', dateTo);
    window.history.replaceState({}, '', `${current.pathname}${current.search}${current.hash}`);

    document.querySelectorAll('a[href^="/admin?"]').forEach((anchor) => {
      let url;
      try {
        url = new URL(anchor.getAttribute('href') || '', window.location.origin);
      } catch {
        return;
      }
      if (url.pathname !== '/admin' || !url.searchParams.has('status')) return;
      setRangeParam(url, 'dateFrom', dateFrom);
      setRangeParam(url, 'dateTo', dateTo);
      anchor.href = `${url.pathname}${url.search}${url.hash}`;
    });

    document.querySelectorAll('form[method="get"][action="/admin"]').forEach((form) => {
      setFormRangeInput(form, 'dateFrom', dateFrom);
      setFormRangeInput(form, 'dateTo', dateTo);
    });
  }

  function installExportRange(bar) {
    if (!bar || bar.dataset.exportDateRangeReady === 'true') return;
    const initialExportLinks = [...bar.querySelectorAll(EXPORT_LINK_SELECTOR)];
    if (!initialExportLinks.length) return;

    bar.dataset.exportDateRangeReady = 'true';

    const initialParams = new URL(window.location.href).searchParams;
    let selectedStart = validIsoDate(initialParams.get('dateFrom'));
    let selectedEnd = validIsoDate(initialParams.get('dateTo'));
    if (selectedStart && selectedEnd && selectedStart > selectedEnd) selectedEnd = '';
    const today = new Date();
    let viewYear = today.getFullYear();
    let viewMonth = today.getMonth();

    const controls = document.createElement('div');
    controls.className = 'candidate-export-date-range';
    controls.dataset.exportDateRange = 'true';

    const title = document.createElement('span');
    title.className = 'candidate-export-date-range-title';
    title.textContent = 'Fecha de registro';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'candidate-export-range-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');

    const triggerText = document.createElement('span');
    const triggerIcon = document.createElement('span');
    triggerIcon.className = 'candidate-export-range-trigger-icon';
    triggerIcon.setAttribute('aria-hidden', 'true');
    triggerIcon.textContent = '▾';
    trigger.append(triggerText, triggerIcon);

    const popover = document.createElement('div');
    popover.className = 'candidate-export-range-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Seleccionar rango de fecha de registro');
    popover.hidden = true;

    const header = document.createElement('div');
    header.className = 'candidate-export-range-header';
    const previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'candidate-export-range-nav';
    previousButton.setAttribute('aria-label', 'Mes anterior');
    previousButton.textContent = '‹';
    const monthLabel = document.createElement('div');
    monthLabel.className = 'candidate-export-range-month';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'candidate-export-range-nav';
    nextButton.setAttribute('aria-label', 'Mes siguiente');
    nextButton.textContent = '›';
    header.append(previousButton, monthLabel, nextButton);

    const weekdays = document.createElement('div');
    weekdays.className = 'candidate-export-range-weekdays';
    WEEKDAYS.forEach((weekday) => {
      const cell = document.createElement('div');
      cell.className = 'candidate-export-range-weekday';
      cell.textContent = weekday;
      weekdays.appendChild(cell);
    });

    const grid = document.createElement('div');
    grid.className = 'candidate-export-range-grid';

    const help = document.createElement('p');
    help.className = 'candidate-export-range-help';

    const footer = document.createElement('div');
    footer.className = 'candidate-export-range-footer';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'candidate-export-range-clear';
    clearButton.textContent = 'Quitar rango';
    footer.appendChild(clearButton);

    popover.append(header, weekdays, grid, help, footer);
    controls.append(title, trigger, popover);
    bar.prepend(controls);

    const panel = bar.closest('[data-vacancy-panel]');
    const vacancyId = String(panel?.getAttribute('data-vacancy-panel') || '');
    installHistoryRangeBehavior(controls, panel, vacancyId);

    const refreshDownloadContext = () => {
      updateContextualRangeDownload(bar, panel, selectedStart, selectedEnd);
    };

    const emitRangeChange = () => {
      controls.dataset.dateFrom = selectedStart;
      controls.dataset.dateTo = selectedEnd;
      syncGlobalRangeNavigation(bar, selectedStart, selectedEnd);
      refreshDownloadContext();
      controls.dispatchEvent(new CustomEvent('candidate-date-range-change', {
        bubbles: true,
        detail: { dateFrom: selectedStart, dateTo: selectedEnd }
      }));

      const globalRangeComplete = bar.dataset.globalCandidateExport === 'true'
        && ((!selectedStart && !selectedEnd) || (selectedStart && selectedEnd));
      if (globalRangeComplete) window.location.reload();
    };

    const updateTrigger = () => {
      if (selectedStart && selectedEnd) {
        triggerText.textContent = `${formatRangeDate(selectedStart)} – ${formatRangeDate(selectedEnd)}`;
      } else if (selectedStart) {
        triggerText.textContent = `Desde ${formatRangeDate(selectedStart)}`;
      } else {
        triggerText.textContent = 'Todas las fechas';
      }
      help.textContent = selectedStart && !selectedEnd
        ? 'Ahora selecciona la fecha final. Puedes cambiar de mes con las flechas.'
        : 'Selecciona la fecha inicial y luego la fecha final.';
    };

    const closePopover = () => {
      popover.hidden = true;
      popover.classList.remove('is-above');
      trigger.setAttribute('aria-expanded', 'false');
    };

    const positionPopover = () => {
      if (popover.hidden) return;
      popover.classList.remove('is-above');
      const controlsRect = controls.getBoundingClientRect();
      const initialRect = popover.getBoundingClientRect();
      const spaceBelow = window.innerHeight - controlsRect.bottom;
      const spaceAbove = controlsRect.top;
      if (initialRect.bottom > window.innerHeight - 12 && spaceAbove > spaceBelow) {
        popover.classList.add('is-above');
      }
    };

    const renderCalendar = () => {
      grid.replaceChildren();
      monthLabel.textContent = MONTH_FORMATTER.format(new Date(viewYear, viewMonth, 1, 12, 0, 0, 0));

      const firstDay = new Date(viewYear, viewMonth, 1, 12, 0, 0, 0);
      const leadingEmptyCells = (firstDay.getDay() + 6) % 7;
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0, 12, 0, 0, 0).getDate();
      const todayIso = isoDate(today.getFullYear(), today.getMonth(), today.getDate());

      for (let index = 0; index < leadingEmptyCells; index += 1) {
        const empty = document.createElement('span');
        empty.className = 'candidate-export-range-empty';
        empty.setAttribute('aria-hidden', 'true');
        grid.appendChild(empty);
      }

      for (let day = 1; day <= daysInMonth; day += 1) {
        const value = isoDate(viewYear, viewMonth, day);
        const dayButton = document.createElement('button');
        dayButton.type = 'button';
        dayButton.className = 'candidate-export-range-day';
        dayButton.textContent = String(day);
        dayButton.dataset.date = value;
        dayButton.setAttribute('aria-label', formatRangeDate(value));
        if (value === todayIso) dayButton.classList.add('is-today');
        if (selectedStart && selectedEnd && value > selectedStart && value < selectedEnd) dayButton.classList.add('is-in-range');
        if (value === selectedStart) dayButton.classList.add('is-start');
        if (value === selectedEnd) dayButton.classList.add('is-end');

        dayButton.addEventListener('click', () => {
          if (!selectedStart || selectedEnd) {
            selectedStart = value;
            selectedEnd = '';
          } else if (value < selectedStart) {
            selectedEnd = selectedStart;
            selectedStart = value;
          } else {
            selectedEnd = value;
          }

          updateTrigger();
          renderCalendar();
          emitRangeChange();
          if (selectedStart && selectedEnd) closePopover();
        });

        grid.appendChild(dayButton);
      }
    };

    const openPopover = () => {
      const reference = dateFromIso(selectedEnd || selectedStart);
      if (reference) {
        viewYear = reference.getFullYear();
        viewMonth = reference.getMonth();
      }
      renderCalendar();
      popover.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      positionPopover();
    };

    trigger.addEventListener('click', () => {
      if (popover.hidden) openPopover();
      else closePopover();
    });

    previousButton.addEventListener('click', () => {
      viewMonth -= 1;
      if (viewMonth < 0) {
        viewMonth = 11;
        viewYear -= 1;
      }
      renderCalendar();
      positionPopover();
    });

    nextButton.addEventListener('click', () => {
      viewMonth += 1;
      if (viewMonth > 11) {
        viewMonth = 0;
        viewYear += 1;
      }
      renderCalendar();
      positionPopover();
    });

    clearButton.addEventListener('click', () => {
      selectedStart = '';
      selectedEnd = '';
      updateTrigger();
      renderCalendar();
      emitRangeChange();
      closePopover();
    });

    controls.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', closePopover);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !popover.hidden) {
        closePopover();
        trigger.focus();
      }
    });
    window.addEventListener('resize', positionPopover);

    panel?.addEventListener('candidate-vacancy-tab-change', refreshDownloadContext);

    bar.addEventListener('click', (event) => {
      const link = event.target.closest(EXPORT_LINK_SELECTOR);
      if (!link || !bar.contains(link)) return;
      const url = new URL(link.getAttribute('href'), window.location.origin);
      if (selectedStart) url.searchParams.set('dateFrom', selectedStart);
      else url.searchParams.delete('dateFrom');
      if (selectedEnd) url.searchParams.set('dateTo', selectedEnd);
      else url.searchParams.delete('dateTo');
      link.href = `${url.pathname}${url.search}${url.hash}`;
    });

    updateTrigger();
    syncGlobalRangeNavigation(bar, selectedStart, selectedEnd);
    refreshDownloadContext();
  }

  function installGlobalExportBar() {
    if (!document.getElementById('legacy-candidates-table')) return null;
    const bar = Array.from(document.querySelectorAll('.export-bar'))
      .find((candidate) => !candidate.closest('[data-vacancy-panel]'));
    if (!bar) return null;

    const params = new URL(window.location.href).searchParams;
    const requestedStatus = String(params.get('status') || 'registered').trim();
    const approvedOnly = params.get('approvedOnly') === '1';
    const scope = approvedOnly ? 'approved' : requestedStatus;
    const label = GLOBAL_EXPORT_LABEL[scope];
    if (!label) return null;

    bar.dataset.globalCandidateExport = 'true';
    bar.dataset.globalCandidateExportScope = scope;
    bar.dataset.globalCandidateExportLabel = label;

    Array.from(bar.querySelectorAll('.filter-note')).forEach((note) => {
      if (/descarga Excel ahora se realiza desde cada vacante/i.test(String(note.textContent || ''))) note.remove();
    });

    let link = bar.querySelector('[data-global-candidate-export-link]');
    if (!link) {
      link = document.createElement('a');
      link.className = 'export-btn';
      link.dataset.globalCandidateExportLink = 'true';
      bar.prepend(link);
    }
    link.href = `/admin/export-global?scope=${encodeURIComponent(scope)}`;
    link.textContent = `↓ Descargar ${label}`;
    return bar;
  }

  function install() {
    if (window.location.pathname !== '/admin') return;
    injectStyles();
    installGlobalExportBar();
    document.querySelectorAll('[data-vacancy-panel] .export-bar, .export-bar[data-global-candidate-export="true"]').forEach(installExportRange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();