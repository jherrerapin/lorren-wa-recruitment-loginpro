'use strict';

(() => {
  const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
  const METRIC_QUERY_KEY = 'metric';
  const LATE_METRIC = 'LATE';

  function removeAll(selector, root = document) {
    root.querySelectorAll(selector).forEach((element) => element.remove());
  }

  function normalized(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-CO');
  }

  function validDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function dateFromKey(value) {
    return validDateKey(value) ? new Date(`${value}T12:00:00.000Z`) : null;
  }

  function keyFromDate(value) {
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString().slice(0, 10)
      : '';
  }

  function formatDate(value) {
    const parts = String(value || '').split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : (value || '—');
  }

  function formatRange(range) {
    if (!range?.from) return '—';
    return range.from === range.to
      ? formatDate(range.from)
      : `${formatDate(range.from)} – ${formatDate(range.to)}`;
  }

  function ensureAttendanceControlsStyle() {
    if (document.getElementById('attendance-compact-controls-style')) return;
    const style = document.createElement('style');
    style.id = 'attendance-compact-controls-style';
    style.textContent = `
      .filter-grid.attendance-filter-grid-compact{grid-template-columns:repeat(4,minmax(0,1fr))}
      .attendance-range-button{width:100%;min-height:39px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--navy);padding:9px 11px;text-align:left;font:inherit;font-size:12px;font-weight:800;cursor:pointer}
      .attendance-range-dialog{border:0;border-radius:14px;padding:0;width:min(390px,calc(100vw - 24px));box-shadow:0 18px 50px rgba(15,23,42,.28)}
      .attendance-range-dialog::backdrop{background:rgba(15,23,42,.42)}
      .attendance-calendar{padding:14px;display:grid;gap:10px;background:#fff}
      .attendance-calendar-head{display:grid;grid-template-columns:36px 1fr 36px;gap:8px;align-items:center}
      .attendance-calendar-head strong{text-align:center;color:var(--navy);font-size:13px;text-transform:capitalize}
      .attendance-calendar-nav{width:36px;height:34px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--navy);font-size:20px;cursor:pointer}
      .attendance-calendar-weekdays,.attendance-calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
      .attendance-calendar-weekdays span{text-align:center;color:var(--muted);font-size:9px;font-weight:900}
      .attendance-calendar-day{aspect-ratio:1;border:1px solid transparent;border-radius:8px;background:#fff;color:var(--navy);font:inherit;font-size:11px;cursor:pointer}
      .attendance-calendar-day.outside{color:#94a3b8}
      .attendance-calendar-day.in-range{background:#e6f4f1}
      .attendance-calendar-day.is-edge{background:var(--teal);color:#fff;font-weight:900}
      .attendance-calendar-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
      .attendance-metric-link{display:block;color:inherit;text-decoration:none;cursor:pointer;font:inherit;transition:transform .12s ease,box-shadow .12s ease}
      .attendance-metric-link:hover,.attendance-metric-link:focus-visible{transform:translateY(-1px);box-shadow:0 7px 20px rgba(15,23,42,.12);outline:2px solid color-mix(in srgb,var(--teal) 55%,transparent);outline-offset:2px}
      .attendance-metric-link[aria-current="page"]{box-shadow:0 0 0 2px color-mix(in srgb,var(--teal) 35%,transparent)}
      .attendance-card.attendance-metric-focus{box-shadow:0 0 0 2px color-mix(in srgb,#b45309 45%,transparent),var(--shadow-sm)}
      @media(max-width:900px){.filter-grid.attendance-filter-grid-compact{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:620px){.filter-grid.attendance-filter-grid-compact{grid-template-columns:1fr}}
    `;
    document.head.append(style);
  }

  function removeSummaryNoise() {
    document.querySelectorAll('.summary-fact').forEach((fact) => {
      const label = normalized(fact.querySelector('span')?.textContent);
      const value = normalized(fact.querySelector('strong')?.textContent);
      const redundantLabel = label.includes('almuerzo') || label.includes('horas extra');
      const placeholder = ['pendiente', 'sin registro', 'no iniciado', 'almuerzo abierto'].some((text) => value.includes(text));
      if (redundantLabel || placeholder) fact.remove();
    });

    document.querySelectorAll('.status-pill').forEach((pill) => {
      if (normalized(pill.textContent).includes('pendiente de salida')) pill.remove();
    });
  }

  function compactVisibleAttendanceRows() {
    document.querySelectorAll('.attendance-hours-cell').forEach((cell) => {
      const primary = cell.querySelector('strong');
      const secondary = cell.querySelector('small');
      const primaryText = String(primary?.textContent || '').trim();
      const secondaryText = String(secondary?.textContent || '').trim();
      if (primary && secondaryText) primary.textContent = `${primaryText} · ${secondaryText}`;
    });

    removeAll('.attendance-mark-cell > small, .attendance-hours-cell > small');
  }

  function restoreMapModeLabels() {
    const labels = Object.freeze({
      arrival: 'Ver entrada en el mapa',
      departure: 'Ver salida en el mapa',
      both: 'Ver ambas en el mapa'
    });

    document.querySelectorAll('[data-map-mode]').forEach((button) => {
      const label = labels[button.dataset.mapMode];
      if (label) button.textContent = label;
    });
  }

  function applySummaryLayout(summary) {
    if (!summary) return;

    summary.style.width = '100%';
    summary.style.maxWidth = '100%';
    summary.style.minWidth = '0';

    summary.querySelectorAll('.summary-name, .summary-identity, .attendance-mark-cell, .attendance-hours-cell').forEach((item) => {
      item.style.minWidth = '0';
      item.style.maxWidth = '100%';
      item.style.overflowWrap = 'anywhere';
    });
  }

  function installSummaryLayouts() {
    const summaries = [...document.querySelectorAll('.summary-main')];
    if (!summaries.length) return;

    const apply = () => summaries.forEach(applySummaryLayout);
    apply();

    if (typeof window.ResizeObserver === 'function') {
      const observer = new window.ResizeObserver((entries) => {
        entries.forEach((entry) => applySummaryLayout(entry.target));
      });
      summaries.forEach((summary) => observer.observe(summary));
      return;
    }

    window.addEventListener('resize', apply);
  }

  function removeDetailNoise() {
    document.querySelectorAll('.recognize-early span').forEach((copy) => {
      copy.innerHTML = '<strong>Reconocer tiempo anterior al turno</strong>';
    });
  }

  function installAttendanceRangePicker() {
    const form = document.querySelector('.filter-card form[method="get"]');
    const grid = form?.querySelector('.filter-grid');
    const fromInput = form?.querySelector('input[name="from"]');
    const toInput = form?.querySelector('input[name="to"]');
    if (!form || !grid || !fromInput || !toInput || form.querySelector('[data-attendance-range-button]')) return;

    ensureAttendanceControlsStyle();

    const fromField = fromInput.closest('.field');
    const toField = toInput.closest('.field');
    fromInput.type = 'hidden';
    toInput.type = 'hidden';
    form.prepend(toInput);
    form.prepend(fromInput);
    fromField?.remove();
    if (toField !== fromField) toField?.remove();
    grid.classList.add('attendance-filter-grid-compact');

    const rangeField = document.createElement('div');
    rangeField.className = 'field attendance-range-field';
    const rangeLabel = document.createElement('label');
    rangeLabel.htmlFor = 'attendanceRangeButton';
    rangeLabel.textContent = 'Fecha / rango';
    const rangeButton = document.createElement('button');
    rangeButton.type = 'button';
    rangeButton.id = 'attendanceRangeButton';
    rangeButton.className = 'attendance-range-button';
    rangeButton.dataset.attendanceRangeButton = 'true';
    rangeButton.setAttribute('aria-haspopup', 'dialog');
    rangeField.append(rangeLabel, rangeButton);
    grid.prepend(rangeField);

    const dialog = document.createElement('dialog');
    dialog.className = 'attendance-range-dialog';
    dialog.id = 'attendanceRangeDialog';
    dialog.setAttribute('aria-label', 'Seleccionar fecha o rango de asistencia');
    dialog.innerHTML = `
      <div class="attendance-calendar">
        <div class="attendance-calendar-head">
          <button class="attendance-calendar-nav" type="button" data-attendance-calendar-prev aria-label="Mes anterior">‹</button>
          <strong data-attendance-calendar-month></strong>
          <button class="attendance-calendar-nav" type="button" data-attendance-calendar-next aria-label="Mes siguiente">›</button>
        </div>
        <div class="attendance-calendar-weekdays"><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span><span>Dom</span></div>
        <div class="attendance-calendar-grid" data-attendance-calendar-grid></div>
        <div class="attendance-calendar-actions"><button class="btn" type="button" data-attendance-calendar-cancel>Cancelar</button><button class="btn btn-primary" type="button" data-attendance-calendar-apply>Aplicar</button></div>
      </div>
    `;
    document.body.append(dialog);

    const monthLabel = dialog.querySelector('[data-attendance-calendar-month]');
    const calendarGrid = dialog.querySelector('[data-attendance-calendar-grid]');
    const previousButton = dialog.querySelector('[data-attendance-calendar-prev]');
    const nextButton = dialog.querySelector('[data-attendance-calendar-next]');
    const cancelButton = dialog.querySelector('[data-attendance-calendar-cancel]');
    const applyButton = dialog.querySelector('[data-attendance-calendar-apply]');
    let pendingRange = null;
    let calendarCursor = null;
    let calendarClickPhase = 0;

    const currentRange = () => {
      const from = validDateKey(fromInput.value) ? fromInput.value : '';
      const to = validDateKey(toInput.value) ? toInput.value : from;
      if (!from) return { from: '', to: '' };
      return from <= to ? { from, to } : { from: to, to: from };
    };

    const syncButton = () => {
      rangeButton.textContent = formatRange(currentRange());
    };

    const renderCalendar = () => {
      if (!calendarGrid || !calendarCursor || !pendingRange) return;
      const year = calendarCursor.getUTCFullYear();
      const month = calendarCursor.getUTCMonth();
      monthLabel.textContent = new Intl.DateTimeFormat('es-CO', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
      }).format(calendarCursor);
      calendarGrid.replaceChildren();
      const first = new Date(Date.UTC(year, month, 1, 12));
      const offset = (first.getUTCDay() + 6) % 7;
      const gridStart = new Date(first);
      gridStart.setUTCDate(first.getUTCDate() - offset);

      for (let index = 0; index < 42; index += 1) {
        const date = new Date(gridStart);
        date.setUTCDate(gridStart.getUTCDate() + index);
        const key = keyFromDate(date);
        const dayButton = document.createElement('button');
        dayButton.type = 'button';
        dayButton.className = 'attendance-calendar-day';
        dayButton.textContent = String(date.getUTCDate());
        dayButton.dataset.date = key;
        dayButton.setAttribute('aria-label', new Intl.DateTimeFormat('es-CO', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC'
        }).format(date));
        if (date.getUTCMonth() !== month) dayButton.classList.add('outside');
        if (key >= pendingRange.from && key <= pendingRange.to) dayButton.classList.add('in-range');
        if (key === pendingRange.from || key === pendingRange.to) dayButton.classList.add('is-edge');
        dayButton.setAttribute('aria-pressed', key >= pendingRange.from && key <= pendingRange.to ? 'true' : 'false');
        dayButton.addEventListener('click', () => {
          if (calendarClickPhase === 0) {
            pendingRange = { from: key, to: key };
            calendarClickPhase = 1;
          } else {
            pendingRange = key < pendingRange.from
              ? { from: key, to: pendingRange.from }
              : { from: pendingRange.from, to: key };
            calendarClickPhase = 0;
          }
          renderCalendar();
        });
        calendarGrid.append(dayButton);
      }
    };

    const closeDialog = () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      rangeButton.focus();
    };

    rangeButton.addEventListener('click', () => {
      const source = currentRange();
      const fallback = validDateKey(source.from) ? source.from : new Date().toISOString().slice(0, 10);
      pendingRange = {
        from: validDateKey(source.from) ? source.from : fallback,
        to: validDateKey(source.to) ? source.to : fallback
      };
      calendarClickPhase = 0;
      const date = dateFromKey(pendingRange.from);
      calendarCursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 12));
      renderCalendar();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });

    previousButton?.addEventListener('click', () => {
      calendarCursor?.setUTCMonth(calendarCursor.getUTCMonth() - 1);
      renderCalendar();
    });
    nextButton?.addEventListener('click', () => {
      calendarCursor?.setUTCMonth(calendarCursor.getUTCMonth() + 1);
      renderCalendar();
    });
    cancelButton?.addEventListener('click', closeDialog);
    applyButton?.addEventListener('click', () => {
      if (!pendingRange) return;
      fromInput.value = pendingRange.from;
      toInput.value = pendingRange.to;
      syncButton();
      closeDialog();
    });

    syncButton();
  }

  function metricTarget(label) {
    const value = normalized(label);
    if (value === 'asignaciones') return { status: 'ALL' };
    if (value === 'por revisar') return { status: 'REVIEW_REQUIRED' };
    if (value === 'automáticas') return { status: 'AUTO_VALIDATED' };
    if (value === 'manuales') return { status: 'MANUAL_VALIDATED' };
    if (value === 'llegadas tarde') return { status: 'ALL', metric: LATE_METRIC };
    if (value === 'rechazadas') return { status: 'REJECTED' };
    if (value === 'sin llegada') return { status: 'NO_SHOW' };
    return null;
  }

  function metricUrl(target, range) {
    const params = new URLSearchParams();
    if (validDateKey(range.from)) params.set('from', range.from);
    if (validDateKey(range.to)) params.set('to', range.to);
    if (target.status && target.status !== 'ALL') params.set('status', target.status);
    if (target.metric) params.set(METRIC_QUERY_KEY, target.metric);
    const query = params.toString();
    return `${ATTENDANCE_PATH}${query ? `?${query}` : ''}#attendance-list`;
  }

  function installMetricNavigation() {
    const metricsGrid = document.querySelector('.metrics-grid');
    if (!metricsGrid || metricsGrid.dataset.metricNavigationInstalled === 'true') return;
    ensureAttendanceControlsStyle();
    metricsGrid.dataset.metricNavigationInstalled = 'true';

    const from = document.querySelector('.filter-card form input[name="from"]')?.value || '';
    const to = document.querySelector('.filter-card form input[name="to"]')?.value || from;
    const range = { from, to };
    const currentParams = new URLSearchParams(window.location.search);
    const currentStatus = currentParams.get('status') || 'ALL';
    const currentMetric = currentParams.get(METRIC_QUERY_KEY) || '';

    [...metricsGrid.querySelectorAll('.metric')].forEach((card) => {
      const label = String(card.querySelector('.metric-label')?.textContent || '').trim();
      const target = metricTarget(label);
      if (!target) return;
      const link = document.createElement('a');
      link.className = `${card.className} attendance-metric-link`;
      link.innerHTML = card.innerHTML;
      link.href = metricUrl(target, range);
      link.setAttribute('aria-label', `Ver ${label.toLocaleLowerCase('es-CO')} del rango seleccionado`);
      const activeStatus = target.status || 'ALL';
      const active = target.metric
        ? currentMetric === target.metric
        : !currentMetric && currentStatus === activeStatus;
      if (active) link.setAttribute('aria-current', 'page');
      card.replaceWith(link);
    });
  }

  function isLateAttendanceCard(card) {
    const statusControl = card.querySelector('[data-review-status]');
    const validationForm = card.querySelector('.attendance-validation-form');
    const lateMinutes = Number(validationForm?.dataset.lateMinutes || 0);
    return statusControl?.value === 'LATE' || lateMinutes > 0;
  }

  function focusMetricRows() {
    const params = new URLSearchParams(window.location.search);
    if (params.get(METRIC_QUERY_KEY) !== LATE_METRIC) return;
    const cards = [...document.querySelectorAll('[data-attendance-card]')];
    const lateCards = cards.filter(isLateAttendanceCard);
    const lateMetricLink = [...document.querySelectorAll('.attendance-metric-link')].find((link) => (
      normalized(link.querySelector('.metric-label')?.textContent) === 'llegadas tarde'
    ));
    const expectedLate = Number(String(lateMetricLink?.querySelector('.metric-value')?.textContent || '').trim());
    lateCards.forEach((card) => card.classList.add('attendance-metric-focus'));

    if (Number.isFinite(expectedLate) && expectedLate === lateCards.length) {
      cards.forEach((card) => { card.hidden = !lateCards.includes(card); });
      const count = document.querySelector('.attendance-list-tools strong');
      if (count) count.textContent = `${lateCards.length} auxiliar(es)`;
    }

    const list = document.querySelector('.attendance-list');
    if (list) list.id = 'attendance-list';
    const target = lateCards[0] || list;
    if (target && typeof target.scrollIntoView === 'function') {
      window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  }

  function focusMetricList() {
    if (new URLSearchParams(window.location.search).has(METRIC_QUERY_KEY)) return;
    if (window.location.hash !== '#attendance-list') return;
    const list = document.querySelector('.attendance-list');
    if (!list) return;
    list.id = 'attendance-list';
    if (typeof list.scrollIntoView === 'function') {
      window.requestAnimationFrame(() => list.scrollIntoView({ block: 'start' }));
    }
  }

  function initialize() {
    removeAll('.hero p');
    removeAll('.attendance-list-tools p');
    removeAll('.calculation-note');
    removeAll('.work-grid');
    removeAll('.attendance-risk-explanation, .risk-score, .risk-flag');
    removeAll('.review-hint');
    removeAll('.info-chip');
    removeSummaryNoise();
    compactVisibleAttendanceRows();
    restoreMapModeLabels();
    installSummaryLayouts();
    removeDetailNoise();
    installAttendanceRangePicker();
    installMetricNavigation();
    focusMetricRows();
    focusMetricList();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
