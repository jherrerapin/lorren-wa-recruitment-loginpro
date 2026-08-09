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

  function applySummaryLayout(summary) {
    if (!summary) return;

    const width = Number(summary.getBoundingClientRect?.().width || summary.clientWidth || 0);
    summary.style.width = '100%';
    summary.style.maxWidth = '100%';
    summary.style.minWidth = '0';
    summary.style.gridTemplateColumns = width > 0 && width < 360
      ? 'minmax(0, 1fr)'
      : (width > 0 && width < 560
        ? 'repeat(2, minmax(0, 1fr))'
        : 'minmax(0, 1.35fr) repeat(3, minmax(0, 1fr))');

    summary.querySelectorAll('.summary-name, .summary-identity').forEach((item) => {
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
    document.querySelectorAll('.risk-flag, .info-chip').forEach((chip) => {
      const text = normalized(chip.textContent);
      if (text.includes('anticipado') || text.includes('hora ordinaria')) chip.remove();
    });

    document.querySelectorAll('.recognize-early span').forEach((copy) => {
      copy.innerHTML = '<strong>Reconocer tiempo anterior al turno</strong>';
    });
  }

  function initialize() {
    removeAll('.hero p');
    removeAll('.attendance-list-tools p');
    removeAll('.calculation-note');
    removeAll('.work-grid');
    removeAll('.attendance-risk-explanation');
    removeAll('.review-hint');
    removeAll('.info-chip');
    removeSummaryNoise();
    installSummaryLayouts();
    removeDetailNoise();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
