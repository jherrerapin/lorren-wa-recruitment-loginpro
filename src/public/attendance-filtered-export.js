'use strict';

(() => {
  const CAPABILITY_URL = '/admin/operaciones/asistencia/reportes/capabilities';
  const EXPORT_URL = '/admin/operaciones/asistencia/reportes/filtrado.xlsx';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cardWorkerKey(card) {
    const name = normalizeText(card.querySelector('.summary-name')?.textContent) || 'Auxiliar sin nombre';
    const documentText = normalizeText(card.querySelector('.summary-main > div:first-child .summary-secondary')?.textContent) || 'Sin documento';
    return `${name}|${documentText}`;
  }

  function currentFilterValue(form, name, fallback = '') {
    const control = form?.querySelector(`[name="${name}"]`);
    if (control) return String(control.value || fallback);
    return new URL(window.location.href).searchParams.get(name) || fallback;
  }

  function filenameFromDisposition(value) {
    const match = String(value || '').match(/filename="?([^";]+)"?/i);
    return match?.[1] || 'asistencia-filtrada.xlsx';
  }

  async function downloadFilteredAttendance(button, filterForm) {
    const cards = [...document.querySelectorAll('[data-attendance-card]')].filter((card) => !card.hidden);
    const workerKeys = [...new Set(cards.map(cardWorkerKey).filter(Boolean))];
    const body = new URLSearchParams();
    ['from', 'to', 'status', 'client'].forEach((name) => {
      const value = currentFilterValue(filterForm, name, name === 'status' || name === 'client' ? 'ALL' : '');
      if (value) body.set(name, value);
    });
    workerKeys.forEach((key) => body.append('workerKey', key));

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparando Excel…';
    try {
      const response = await fetch(EXPORT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      });
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filenameFromDisposition(response.headers.get('content-disposition'));
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.alert(error?.message || 'No fue posible descargar la asistencia filtrada.');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function install() {
    if (window.location.pathname !== '/admin/operaciones/asistencia') return;
    const filterForm = document.querySelector('.filter-card form[method="get"]');
    const actions = filterForm?.querySelector('.filter-actions');
    if (!filterForm || !actions || actions.querySelector('[data-attendance-filtered-export]')) return;

    try {
      const response = await fetch(CAPABILITY_URL, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return;
      const capability = await response.json();
      if (capability?.canExport !== true) return;
    } catch {
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.dataset.attendanceFilteredExport = 'true';
    button.textContent = 'Descargar filtrado (Excel)';
    button.addEventListener('click', () => downloadFilteredAttendance(button, filterForm));
    actions.appendChild(button);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
