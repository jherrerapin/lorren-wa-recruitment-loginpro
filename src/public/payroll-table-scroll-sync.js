'use strict';

(() => {
  const STYLE_ID = 'payroll-table-scroll-sync-style';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .payroll-table-scroll-top{width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden;height:16px;margin:0 0 5px;border:1px solid var(--border,#e1e4e8);border-radius:8px;background:#f8fafc;-webkit-overflow-scrolling:touch}
      .payroll-table-scroll-top[hidden]{display:none!important}
      .payroll-table-scroll-top-spacer{height:1px;min-height:1px}
    `;
    document.head.appendChild(style);
  }

  function installFor(tableWrap) {
    if (!tableWrap || tableWrap.dataset.payrollTopScroll === 'true') return;
    tableWrap.dataset.payrollTopScroll = 'true';

    const top = document.createElement('div');
    top.className = 'payroll-table-scroll-top';
    top.setAttribute('aria-label', 'Desplazamiento horizontal superior de la tabla');
    const spacer = document.createElement('div');
    spacer.className = 'payroll-table-scroll-top-spacer';
    top.appendChild(spacer);
    tableWrap.parentNode.insertBefore(top, tableWrap);

    let syncing = false;
    const refresh = () => {
      const table = tableWrap.querySelector('table');
      const width = Math.max(table?.scrollWidth || 0, tableWrap.scrollWidth || 0);
      spacer.style.width = `${width}px`;
      top.hidden = width <= tableWrap.clientWidth + 1;
      if (!top.hidden) top.scrollLeft = tableWrap.scrollLeft;
    };

    const sync = (source, target) => {
      if (syncing) return;
      syncing = true;
      target.scrollLeft = source.scrollLeft;
      window.requestAnimationFrame(() => { syncing = false; });
    };

    top.addEventListener('scroll', () => sync(top, tableWrap), { passive: true });
    tableWrap.addEventListener('scroll', () => sync(tableWrap, top), { passive: true });
    window.addEventListener('resize', refresh, { passive: true });
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(refresh);
      observer.observe(tableWrap);
      const table = tableWrap.querySelector('table');
      if (table) observer.observe(table);
    }
    refresh();
  }

  function install() {
    if (!window.location.pathname.includes('/admin/operaciones/asistencia/gestion-tiempo')) return;
    injectStyles();
    document.querySelectorAll('.payroll-results-panel .table-wrap').forEach(installFor);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
