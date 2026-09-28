'use strict';

(() => {
  const STYLE_ID = 'payroll-table-scroll-sync-style';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .payroll-table-scroll-top{width:100%;overflow-x:auto;overflow-y:hidden;margin:0 0 8px;border:1px solid var(--border,#e1e4e8);border-radius:8px;background:#fff;-webkit-overflow-scrolling:touch}
      .payroll-table-scroll-top[hidden]{display:none!important}
      .payroll-table-scroll-top-spacer{height:1px;pointer-events:none}
    `;
    document.head.appendChild(style);
  }

  function install() {
    const tableWrap = document.querySelector('.payroll-results-panel .table-wrap');
    if (!tableWrap || tableWrap.dataset.payrollTopScroll === 'true') return;
    tableWrap.dataset.payrollTopScroll = 'true';
    injectStyles();

    const top = document.createElement('div');
    top.className = 'payroll-table-scroll-top';
    top.setAttribute('aria-label', 'Desplazamiento horizontal superior de Gestión de Tiempo');
    const spacer = document.createElement('div');
    spacer.className = 'payroll-table-scroll-top-spacer';
    top.appendChild(spacer);
    tableWrap.parentNode.insertBefore(top, tableWrap);

    let syncing = false;
    const syncWidth = () => {
      const scrollWidth = tableWrap.scrollWidth;
      spacer.style.width = `${scrollWidth}px`;
      top.hidden = scrollWidth <= tableWrap.clientWidth + 1;
      top.scrollLeft = tableWrap.scrollLeft;
    };

    const mirror = (source, target) => {
      if (syncing) return;
      syncing = true;
      target.scrollLeft = source.scrollLeft;
      window.requestAnimationFrame(() => { syncing = false; });
    };

    top.addEventListener('scroll', () => mirror(top, tableWrap), { passive: true });
    tableWrap.addEventListener('scroll', () => mirror(tableWrap, top), { passive: true });

    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(syncWidth)
      : null;
    observer?.observe(tableWrap);
    const table = tableWrap.querySelector('table');
    if (table) observer?.observe(table);
    window.addEventListener('resize', syncWidth, { passive: true });
    syncWidth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
