'use strict';

const BIOMETRIC_ASSET_RELEASE = '20260803-worker-portal-runtime-v5';
const BIOMETRIC_SHELL_CACHE = 'lorren-worker-portal-shell-v10';
const BIOMETRIC_SHELL_RELOAD_KEY = `lorren-shell-reloaded:${BIOMETRIC_SHELL_CACHE}`;
const WORKER_PORTAL_USER_AGENT = String(window.navigator.userAgent || '');
const LOAD_WORKER_PORTAL_HANDOFF = /Android/i.test(WORKER_PORTAL_USER_AGENT);

window.LorrenBiometricAssetRelease = BIOMETRIC_ASSET_RELEASE;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const message = event?.data;
    if (
      message?.type !== 'PORTAL_SHELL_UPDATED'
      || message?.cacheName !== BIOMETRIC_SHELL_CACHE
      || window.sessionStorage.getItem(BIOMETRIC_SHELL_RELOAD_KEY) === 'true'
    ) return;

    window.sessionStorage.setItem(BIOMETRIC_SHELL_RELOAD_KEY, 'true');
    window.location.reload();
  });

  navigator.serviceWorker.getRegistration('/operaciones/portal')
    .then((registration) => registration?.update?.())
    .catch(() => {});
}

document.write(`<script src="/public/worker-biometric-core.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-biometric-mobile.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-biometric-flow.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-offline.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-offline-controller.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
if (LOAD_WORKER_PORTAL_HANDOFF) {
  document.write(`<script src="/public/worker-portal-session-handoff.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
}
document.write(`<script src="/public/worker-portal-install.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);

(() => {
  if (!/^\/operaciones\/portal\/?$/.test(window.location.pathname)) return;

  const list = document.querySelector('.assignment-list');
  if (!list || document.body.classList.contains('portal-filters-ready')) return;
  const cards = Array.from(list.querySelectorAll(':scope > .assignment-card'));
  if (!cards.length) return;

  const PORTAL_FILTER_STYLE = `
    body.portal-filters-ready main{width:min(100%,720px)}
    .portal-filter-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:0 0 14px;overflow:hidden;border:1px solid #dfe5e9;border-radius:16px;background:#dfe5e9}
    .portal-filter-summary div{padding:13px 8px;background:#fff;text-align:center}
    .portal-filter-summary span{display:block;color:#71808c;font-size:11px;font-weight:750;text-transform:uppercase}
    .portal-filter-summary strong{display:block;margin-top:4px;color:#23313d;font-size:19px}
    .portal-filter-panel{margin:0 0 18px;padding:16px;border:1px solid #dfe5e9;border-radius:18px;background:#fff;box-shadow:0 10px 28px rgba(23,33,43,.06)}
    .portal-filter-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
    .portal-filter-head h2{font-size:17px}.portal-filter-head p{margin-top:3px;font-size:12px}.portal-filter-result{color:#176c36;font-size:12px;font-weight:850;white-space:nowrap}
    .portal-quick-filters{display:flex;gap:7px;margin-bottom:12px;overflow-x:auto;scrollbar-width:none}.portal-quick-filters::-webkit-scrollbar{display:none}
    .portal-quick-filter{flex:0 0 auto;padding:8px 11px;border:1px solid #d5dde2;border-radius:999px;background:#fff;color:#4b5965;font-size:12px;font-weight:800;cursor:pointer}
    .portal-quick-filter.active{border-color:#176c36;background:#eaf8ef;color:#176c36}
    .portal-filter-grid{display:grid;grid-template-columns:1fr 1fr 1.15fr auto;gap:9px;align-items:end}
    .portal-filter-field{display:grid;gap:5px;color:#687682;font-size:11px;font-weight:750}
    .portal-filter-field input,.portal-filter-field select{width:100%;min-height:42px;border:1px solid #d7dee3;border-radius:11px;padding:9px 10px;background:#fff;color:#263645}
    .portal-clear-filter{min-height:42px;border:0;border-radius:11px;padding:9px 12px;background:#edf1f3;color:#42515d;font-weight:800;cursor:pointer}
    .portal-date-groups{display:grid;gap:20px}.portal-date-group{display:grid;gap:10px}.portal-date-group[hidden],.assignment-card[hidden]{display:none}
    .portal-date-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 3px}
    .portal-date-title{display:flex;align-items:center;gap:10px}.portal-date-dot{width:9px;height:9px;border-radius:50%;background:#176c36;box-shadow:0 0 0 5px rgba(23,108,54,.11)}
    .portal-date-title h2{font-size:16px;text-transform:capitalize}.portal-group-count{color:#788590;font-size:12px;font-weight:750}
    .portal-date-list{display:grid;gap:10px}.portal-filtered-empty{margin-top:8px}
    @media(max-width:620px){.portal-filter-grid{grid-template-columns:1fr 1fr}.portal-status-filter,.portal-clear-filter{grid-column:1/-1}}
  `;

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function parseAssignmentDate(label) {
    const match = String(label || '').toLowerCase().match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
    if (!match) return '';
    const months = {
      enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
      julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12'
    };
    const month = months[match[2]];
    return month ? `${match[3]}-${month}-${String(match[1]).padStart(2, '0')}` : '';
  }

  function bogotaDateKey(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDays(dateKey, days) {
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function assignmentStatus(card) {
    if (card.classList.contains('completed')) return 'COMPLETED';
    if (card.querySelector('[data-mark-type="DEPARTURE"]')) return 'IN_PROGRESS';
    return 'PENDING';
  }

  const items = cards.map((card) => {
    const dateLabel = card.querySelector('.assignment-date')?.textContent.trim() || 'Fecha pendiente';
    return {
      card,
      dateLabel,
      dateKey: parseAssignmentDate(dateLabel),
      status: assignmentStatus(card)
    };
  });

  const style = createElement('style');
  style.dataset.workerPortalFilters = 'true';
  style.textContent = PORTAL_FILTER_STYLE;
  document.head.append(style);
  document.body.classList.add('portal-filters-ready');

  const summary = createElement('section', 'portal-filter-summary');
  summary.setAttribute('aria-label', 'Resumen de asignaciones');
  [
    ['Pendientes', items.filter((item) => item.status === 'PENDING').length],
    ['En curso', items.filter((item) => item.status === 'IN_PROGRESS').length],
    ['Finalizadas', items.filter((item) => item.status === 'COMPLETED').length]
  ].forEach(([label, value]) => {
    const stat = createElement('div');
    stat.append(createElement('span', '', label), createElement('strong', '', String(value)));
    summary.append(stat);
  });
  list.parentNode.insertBefore(summary, list);

  const groups = new Map();
  items.forEach((item) => {
    const key = item.dateKey || item.dateLabel;
    if (!groups.has(key)) groups.set(key, { key, label: item.dateLabel, items: [] });
    groups.get(key).items.push(item);
  });

  const groupsContainer = createElement('section', 'portal-date-groups');
  groupsContainer.id = 'portal-assignment-groups';
  groupsContainer.setAttribute('aria-label', 'Asignaciones agrupadas por fecha');
  groups.forEach((group) => {
    const section = createElement('section', 'portal-date-group');
    section.dataset.portalDateGroup = group.key;
    const header = createElement('header', 'portal-date-header');
    const title = createElement('div', 'portal-date-title');
    title.append(createElement('span', 'portal-date-dot'), createElement('h2', '', group.label));
    const count = createElement('span', 'portal-group-count', `${group.items.length} asignación${group.items.length === 1 ? '' : 'es'}`);
    count.dataset.portalGroupCount = 'true';
    header.append(title, count);
    const dateList = createElement('div', 'portal-date-list');
    group.items.forEach((item) => dateList.append(item.card));
    section.append(header, dateList);
    groupsContainer.append(section);
  });
  list.replaceWith(groupsContainer);

  const panel = createElement('section', 'portal-filter-panel');
  panel.setAttribute('aria-label', 'Filtros de asignaciones');
  const head = createElement('div', 'portal-filter-head');
  const heading = createElement('div');
  heading.append(createElement('h2', '', 'Organizar asignaciones'), createElement('p', '', 'Filtra por periodo o estado.'));
  const result = createElement('span', 'portal-filter-result', `${items.length} visibles`);
  head.append(heading, result);

  const quick = createElement('div', 'portal-quick-filters');
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', 'Periodos rápidos');
  const presetButtons = [
    ['today', 'Hoy'], ['upcoming', 'Próximas'], ['week', '7 días'], ['all', 'Todas']
  ].map(([value, label]) => {
    const button = createElement('button', `portal-quick-filter${value === 'upcoming' ? ' active' : ''}`, label);
    button.type = 'button';
    button.dataset.portalPreset = value;
    quick.append(button);
    return button;
  });

  const grid = createElement('div', 'portal-filter-grid');
  const fromLabel = createElement('label', 'portal-filter-field', 'Desde');
  const fromInput = createElement('input');
  fromInput.type = 'date';
  fromInput.id = 'assignment-date-from';
  fromLabel.append(fromInput);
  const toLabel = createElement('label', 'portal-filter-field', 'Hasta');
  const toInput = createElement('input');
  toInput.type = 'date';
  toInput.id = 'assignment-date-to';
  toLabel.append(toInput);
  const statusLabel = createElement('label', 'portal-filter-field portal-status-filter', 'Estado');
  const statusSelect = createElement('select');
  statusSelect.id = 'assignment-status-filter';
  [['', 'Todos los estados'], ['PENDING', 'Pendientes'], ['IN_PROGRESS', 'En curso'], ['COMPLETED', 'Finalizadas']]
    .forEach(([value, label]) => {
      const option = createElement('option', '', label);
      option.value = value;
      statusSelect.append(option);
    });
  statusLabel.append(statusSelect);
  const clear = createElement('button', 'portal-clear-filter', 'Limpiar');
  clear.type = 'button';
  clear.id = 'clear-assignment-filters';
  grid.append(fromLabel, toLabel, statusLabel, clear);
  panel.append(head, quick, grid);
  groupsContainer.parentNode.insertBefore(panel, groupsContainer);

  const empty = createElement('section', 'empty-state portal-filtered-empty');
  empty.hidden = true;
  empty.append(
    createElement('h2', '', 'No hay asignaciones en este filtro'),
    createElement('p', '', 'Cambia el periodo o limpia los filtros para ver otras fechas.')
  );
  groupsContainer.parentNode.insertBefore(empty, groupsContainer.nextSibling);

  function activatePreset(name) {
    presetButtons.forEach((button) => button.classList.toggle('active', button.dataset.portalPreset === name));
  }

  function applyFilters() {
    const from = fromInput.value;
    const to = toInput.value;
    const status = statusSelect.value;
    const activePreset = presetButtons.find((button) => button.classList.contains('active'))?.dataset.portalPreset || '';
    let visibleCount = 0;

    items.forEach((item) => {
      const matchesFrom = !from || !item.dateKey || item.dateKey >= from;
      const matchesTo = !to || !item.dateKey || item.dateKey <= to;
      const matchesStatus = !status || status === item.status;
      const keepActiveJourney = activePreset === 'upcoming' && item.status === 'IN_PROGRESS';
      const visible = (keepActiveJourney || (matchesFrom && matchesTo)) && matchesStatus;
      item.card.hidden = !visible;
      if (visible) visibleCount += 1;
    });

    Array.from(groupsContainer.querySelectorAll('.portal-date-group')).forEach((group) => {
      const visibleCards = Array.from(group.querySelectorAll('.assignment-card')).filter((card) => !card.hidden);
      group.hidden = visibleCards.length === 0;
      const counter = group.querySelector('[data-portal-group-count]');
      if (counter) counter.textContent = `${visibleCards.length} asignación${visibleCards.length === 1 ? '' : 'es'}`;
    });

    result.textContent = `${visibleCount} visible${visibleCount === 1 ? '' : 's'}`;
    empty.hidden = visibleCount !== 0;
  }

  function setPreset(name) {
    const today = bogotaDateKey();
    if (name === 'today') {
      fromInput.value = today;
      toInput.value = today;
    } else if (name === 'week') {
      fromInput.value = today;
      toInput.value = addDays(today, 6);
    } else if (name === 'upcoming') {
      fromInput.value = today;
      toInput.value = '';
    } else {
      fromInput.value = '';
      toInput.value = '';
    }
    activatePreset(name);
    applyFilters();
  }

  presetButtons.forEach((button) => button.addEventListener('click', () => setPreset(button.dataset.portalPreset)));
  fromInput.addEventListener('change', () => { activatePreset(''); applyFilters(); });
  toInput.addEventListener('change', () => { activatePreset(''); applyFilters(); });
  statusSelect.addEventListener('change', applyFilters);
  clear.addEventListener('click', () => { statusSelect.value = ''; setPreset('all'); });
  setPreset('upcoming');
})();
