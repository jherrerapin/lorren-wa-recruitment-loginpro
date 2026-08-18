'use strict';

(() => {
  function removeAll(selector, root = document) {
    root.querySelectorAll(selector).forEach((element) => element.remove());
  }

  function normalized(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-CO');
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
