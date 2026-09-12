'use strict';

(() => {
  const STYLE_ID = 'candidate-vacancy-section-tabs-style';
  const DATE_RANGE_SCRIPT = '/public/candidate-export-date-range.js';
  const MANAGEMENT_HIDDEN_ATTR = 'data-section-tabs-management-hidden';
  const TAB_CONTEXT_PREFIX = 'vacancyTab_';
  const STATUS_TAB_KEYS = new Set(['registered', 'approved', 'contacted', 'contracted', 'rejected']);
  const REMOTE_STATUS_KEYS = new Set(['contacted', 'contracted', 'rejected']);
  const TAB_ORDER = [
    'interview-management',
    'interviews',
    'registered',
    'missing-cv',
    'approved',
    'contacted',
    'contracted',
    'rejected'
  ];
  const EXPORT_SCOPE_BY_TAB = Object.freeze({
    registered: 'registered',
    'missing-cv': 'missing_cv_complete',
    approved: 'approved',
    contacted: 'contacted',
    contracted: 'contracted',
    rejected: 'rejected'
  });
  const EXPORT_LABEL_BY_TAB = Object.freeze({
    registered: 'registrados',
    'missing-cv': 'completos sin HV',
    approved: 'aprobados',
    contacted: 'contactados',
    contracted: 'contratados',
    rejected: 'rechazados'
  });
  const TAB_DEFINITIONS = [
    {
      key: 'interviews',
      label: 'Entrevistas',
      matches: (title) => title.includes('entrevistas')
    },
    {
      key: 'registered',
      label: 'Registrados',
      matches: (title) => title.includes('registrados completos') || title.includes('pendientes de agendar')
    },
    {
      key: 'missing-cv',
      label: 'Completos sin HV',
      matches: (title) => title.includes('completos pendientes de hv')
    },
    {
      key: 'approved',
      label: 'Aprobados',
      matches: (title) => title === 'aprobados' || title.startsWith('aprobados ')
    },
    {
      key: 'contracted',
      label: 'Contratados',
      matches: (title) => title === 'contratados' || title.startsWith('contratados ')
    }
  ];

  function ensureDateRangeScript() {
    if (document.querySelector(`script[src="${DATE_RANGE_SCRIPT}"]`)) return;
    const script = document.createElement('script');
    script.src = DATE_RANGE_SCRIPT;
    script.defer = true;
    document.head.appendChild(script);
  }

  function normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .candidate-vacancy-section-tabs{display:flex;gap:6px;overflow-x:auto;padding:10px 18px 0;border-top:1px solid #eaecef;background:#fff;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
      .candidate-vacancy-section-tab{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;border:1px solid #e1e4e8;border-bottom:0;border-radius:8px 8px 0 0;padding:8px 13px;background:#f9fafb;color:#64748b;font:inherit;font-size:12px;font-weight:700;cursor:pointer;min-height:38px;text-decoration:none}
      .candidate-vacancy-section-tab:hover{background:#f3f4f6;color:#1e2d3d}
      .candidate-vacancy-section-tab[aria-selected="true"]{background:#fff;color:#1e2d3d;border-color:#cbd5e1;box-shadow:inset 0 2px 0 #0d7a6b}
      .candidate-vacancy-section-tab:focus-visible{outline:2px solid rgba(13,122,107,.24);outline-offset:-2px}
      .candidate-vacancy-section-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#eef2f7;color:#475569;font-size:10px;font-weight:800}
      .candidate-vacancy-section-tab[aria-selected="true"] .candidate-vacancy-section-tab-count{background:#e6f4f1;color:#0d5f54}
      .candidate-vacancy-section-panel[hidden]{display:none!important}
      .candidate-vacancy-section-history-actions{display:flex;justify-content:flex-end;align-items:center;margin:0 0 10px;gap:8px}
      .candidate-vacancy-section-view-all{white-space:nowrap}
      .candidate-vacancy-remote-status-content{padding:0 18px 16px;overflow-x:auto}
      .candidate-vacancy-remote-status-content .legacy-table{width:100%;margin:0}
      .candidate-vacancy-remote-status-state{padding:18px;color:#64748b;font-size:12px}
      .candidate-vacancy-remote-status-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px;border:1px solid #fecaca;border-radius:8px;background:#fff7f7;color:#991b1b;font-size:12px}
      .candidate-export-date-range[data-vacancy-tab-range="true"]{padding:12px 18px;margin:0;background:#fff;border-bottom:1px solid #eaecef}
      .candidate-export-date-range[data-vacancy-tab-range="true"][hidden]{display:none!important}
      @media(max-width:768px){
        .candidate-vacancy-section-tabs{padding:10px 14px 0;gap:5px}
        .candidate-vacancy-section-tab{padding:9px 11px;min-height:42px}
        .candidate-vacancy-section-history-actions{justify-content:flex-start}
        .candidate-vacancy-remote-status-content{padding:0 14px 14px}
        .candidate-export-date-range[data-vacancy-tab-range="true"]{padding:10px 14px}
      }
    `;
    document.head.appendChild(style);
  }

  function sectionDescriptor(section) {
    const titleElement = section.querySelector('.section-title');
    const title = normalize(titleElement?.textContent);
    if (!title) return null;
    const definition = TAB_DEFINITIONS.find((candidate) => candidate.matches(title));
    if (!definition) return null;
    const count = String(section.querySelector('.section-count')?.textContent || '').trim();
    return { ...definition, section, count };
  }

  function managementDescriptor(panel) {
    const section = panel.querySelector('[data-interview-coordination-board]');
    if (!section) return null;
    return {
      key: 'interview-management',
      label: 'Gestión de entrevistas',
      section,
      count: ''
    };
  }

  function safeId(value) {
    return String(value || 'vacancy').replace(/[^a-zA-Z0-9_-]+/g, '-');
  }

  function tabContextParam(vacancyId) {
    return TAB_CONTEXT_PREFIX + String(vacancyId || 'vacancy');
  }

  function descriptorOrder(descriptor) {
    const index = TAB_ORDER.indexOf(descriptor.key);
    return index === -1 ? TAB_ORDER.length : index;
  }

  function validDateParam(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function hasApplicantDateRange() {
    const params = new URL(window.location.href).searchParams;
    return validDateParam(params.get('dateFrom')) || validDateParam(params.get('dateTo'));
  }

  function buildRemoteStatusSection(label, key) {
    const section = document.createElement('div');
    section.className = 'section candidate-vacancy-remote-status-section';
    section.dataset.remoteStatusSection = key;

    const header = document.createElement('div');
    header.className = 'section-header';
    const title = document.createElement('span');
    title.className = 'section-title';
    title.textContent = label;
    const count = document.createElement('span');
    count.className = 'section-count';
    count.textContent = '—';
    header.append(title, count);

    const content = document.createElement('div');
    content.className = 'candidate-vacancy-remote-status-content';
    const state = document.createElement('div');
    state.className = 'candidate-vacancy-remote-status-state';
    state.textContent = 'Selecciona la pestaña para cargar los registros.';
    content.appendChild(state);

    section.append(header, content);
    return section;
  }

  function replaceLocalStatusDescriptorsForDateRange(localDescriptors, vacancyBody, rangeActive) {
    if (!rangeActive) return localDescriptors;

    const replacedKeys = new Set();
    const resolved = [];
    for (const descriptor of localDescriptors) {
      const scope = EXPORT_SCOPE_BY_TAB[descriptor.key] || '';
      if (!scope) {
        resolved.push(descriptor);
        continue;
      }

      if (descriptor.section) descriptor.section.hidden = true;
      if (replacedKeys.has(descriptor.key)) continue;
      replacedKeys.add(descriptor.key);

      const section = buildRemoteStatusSection(descriptor.label, descriptor.key);
      vacancyBody.appendChild(section);
      resolved.push({
        ...descriptor,
        section,
        count: '',
        remoteHref: `/admin?status=${encodeURIComponent(scope)}`,
        remoteState: 'idle',
        dateRangeBacked: true
      });
    }
    return resolved;
  }

  function statusNavigationDescriptors(panel, vacancyBody, localKeys) {
    const filterBar = panel.querySelector('[data-vacancy-status-filters]');
    if (!filterBar) return [];

    const descriptors = [];
    filterBar.querySelectorAll('a[data-vacancy-status-scope]').forEach((anchor) => {
      const key = String(anchor.dataset.vacancyStatusScope || '').trim();
      if (!STATUS_TAB_KEYS.has(key) || localKeys.has(key)) return;
      const label = String(anchor.textContent || key).trim();

      if (REMOTE_STATUS_KEYS.has(key)) {
        const section = buildRemoteStatusSection(label, key);
        vacancyBody.appendChild(section);
        descriptors.push({
          key,
          label,
          section,
          count: '',
          remoteHref: anchor.getAttribute('href') || '',
          remoteState: 'idle'
        });
        return;
      }

      descriptors.push({
        key,
        label,
        link: anchor,
        count: ''
      });
    });

    filterBar.hidden = true;
    filterBar.style.setProperty('display', 'none', 'important');
    filterBar.setAttribute('aria-hidden', 'true');
    return descriptors;
  }

  function buildRemoteStatusUrl(descriptor, vacancyId) {
    const url = new URL(descriptor.remoteHref || '/admin', window.location.origin);
    url.searchParams.set('vacancyId', vacancyId);
    const current = new URL(window.location.href);
    current.searchParams.forEach((value, key) => {
      if (key.startsWith('vh_') || key === 'dateFrom' || key === 'dateTo') {
        url.searchParams.set(key, value);
      }
    });
    return url;
  }

  function setRemoteTabCount(tab, descriptor, value) {
    const countValue = String(value);
    const sectionCount = descriptor.section?.querySelector('.section-count');
    if (sectionCount) sectionCount.textContent = countValue;
    let tabCount = tab?.querySelector('.candidate-vacancy-section-tab-count');
    if (!tabCount && tab) {
      tabCount = document.createElement('span');
      tabCount.className = 'candidate-vacancy-section-tab-count';
      tab.appendChild(tabCount);
    }
    if (tabCount) tabCount.textContent = countValue;
  }

  async function loadRemoteStatusSection(descriptor, tab, vacancyId) {
    if (!descriptor?.remoteHref || descriptor.remoteState === 'loading' || descriptor.remoteState === 'loaded') return;
    const content = descriptor.section?.querySelector('.candidate-vacancy-remote-status-content');
    if (!content) return;

    descriptor.remoteState = 'loading';
    const loading = document.createElement('div');
    loading.className = 'candidate-vacancy-remote-status-state';
    loading.textContent = 'Cargando registros…';
    content.replaceChildren(loading);

    const remoteUrl = buildRemoteStatusUrl(descriptor, vacancyId);
    try {
      const response = await fetch(remoteUrl.pathname + remoteUrl.search, {
        credentials: 'same-origin',
        headers: { Accept: 'text/html' }
      });
      if (!response.ok) throw new Error(`status_${response.status}`);
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const sourceTable = parsed.querySelector('#legacy-candidates-table');
      const rows = sourceTable ? sourceTable.querySelectorAll('tbody tr').length : 0;
      setRemoteTabCount(tab, descriptor, rows);

      if (!sourceTable || rows === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const message = document.createElement('p');
        message.textContent = `No hay candidatos ${descriptor.label.toLowerCase()} en esta vacante.`;
        empty.appendChild(message);
        content.replaceChildren(empty);
        descriptor.remoteState = 'loaded';
        return;
      }

      const table = document.importNode(sourceTable, true);
      table.removeAttribute('id');
      table.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
      content.replaceChildren(table);
      descriptor.remoteState = 'loaded';
    } catch (_error) {
      descriptor.remoteState = 'error';
      const errorBox = document.createElement('div');
      errorBox.className = 'candidate-vacancy-remote-status-error';
      const message = document.createElement('span');
      message.textContent = 'No fue posible cargar estos registros dentro de la vacante.';
      const fallback = document.createElement('a');
      fallback.className = 'export-btn';
      fallback.href = remoteUrl.pathname + remoteUrl.search;
      fallback.textContent = 'Abrir vista alternativa';
      errorBox.append(message, fallback);
      content.replaceChildren(errorBox);
    }
  }

  function exportScope(anchor) {
    try {
      return new URL(anchor.getAttribute('href') || '', window.location.origin).searchParams.get('scope');
    } catch {
      return null;
    }
  }

  function ensureContextualExportLink(panel, activeKey, expectedScope) {
    if (!expectedScope) return null;
    const bar = panel.querySelector('.export-bar');
    if (!bar) return null;
    const existing = [...bar.querySelectorAll('a[href*="/admin/export?"]')]
      .find((anchor) => exportScope(anchor) === expectedScope);
    if (existing) return existing;

    const vacancyId = String(panel.getAttribute('data-vacancy-panel') || '').trim();
    if (!vacancyId) return null;
    const anchor = document.createElement('a');
    anchor.className = 'export-btn';
    anchor.href = `/admin/export?scope=${encodeURIComponent(expectedScope)}&vacancyId=${encodeURIComponent(vacancyId)}`;
    anchor.textContent = `↓ Descargar ${EXPORT_LABEL_BY_TAB[activeKey] || activeKey}`;
    anchor.dataset.generatedContextualExport = activeKey;
    const allAnchor = [...bar.querySelectorAll('a[href*="/admin/export?"]')]
      .find((candidate) => exportScope(candidate) === 'all');
    if (allAnchor) allAnchor.insertAdjacentElement('beforebegin', anchor);
    else bar.appendChild(anchor);
    return anchor;
  }

  function placeDateRangeControl(panel, tabList) {
    const controls = panel.querySelector('.candidate-export-date-range');
    if (!controls) return false;
    if (controls.previousElementSibling !== tabList) tabList.insertAdjacentElement('afterend', controls);
    controls.dataset.vacancyTabRange = 'true';
    controls.hidden = !String(panel.dataset.activeVacancyExportScope || '');
    return true;
  }

  function installDateRangeIntegration(panel, tabList, vacancyId) {
    if (!placeDateRangeControl(panel, tabList)) {
      const observer = new MutationObserver(() => {
        if (placeDateRangeControl(panel, tabList)) observer.disconnect();
      });
      observer.observe(panel, { childList: true, subtree: true });
      window.setTimeout(() => observer.disconnect(), 5000);
    }

    panel.addEventListener('candidate-date-range-change', (event) => {
      const dateFrom = validDateParam(event.detail?.dateFrom) ? String(event.detail.dateFrom) : '';
      const dateTo = validDateParam(event.detail?.dateTo) ? String(event.detail.dateTo) : '';
      const completeSelection = (!dateFrom && !dateTo) || Boolean(dateFrom && dateTo);
      if (!completeSelection) return;

      const url = new URL(window.location.href);
      if (dateFrom) url.searchParams.set('dateFrom', dateFrom);
      else url.searchParams.delete('dateFrom');
      if (dateTo) url.searchParams.set('dateTo', dateTo);
      else url.searchParams.delete('dateTo');

      const activeKey = String(panel.dataset.activeVacancyTab || '');
      if (activeKey) url.searchParams.set(tabContextParam(vacancyId), activeKey);
      url.hash = `vacancy-${vacancyId}`;
      window.location.assign(url.pathname + url.search + url.hash);
    });
  }

  function updateContextualActions(panel, activeKey) {
    const expectedScope = EXPORT_SCOPE_BY_TAB[activeKey] || null;
    const managementActive = activeKey === 'interview-management';
    ensureContextualExportLink(panel, activeKey, expectedScope);

    panel.dataset.activeVacancyTab = activeKey;
    panel.dataset.activeVacancyExportScope = expectedScope || '';

    const rangeControl = panel.querySelector('.candidate-export-date-range');
    if (rangeControl) rangeControl.hidden = !expectedScope;

    panel.querySelectorAll('.export-bar a[href*="/admin/export?"]').forEach((anchor) => {
      const scope = exportScope(anchor);
      anchor.hidden = managementActive || !(scope === 'all' || (expectedScope && scope === expectedScope));
    });

    panel.querySelectorAll('a[href^="/admin/outreach/approved"]').forEach((anchor) => {
      anchor.hidden = activeKey !== 'approved';
    });

    panel.dispatchEvent(new CustomEvent('candidate-vacancy-tab-change', {
      bubbles: true,
      detail: { key: activeKey, scope: expectedScope || '' }
    }));
  }

  function updateManagementLayout(panel, tabList, managementSection, activeKey) {
    const managementActive = activeKey === 'interview-management';

    [...panel.children].forEach((child) => {
      const keepVisible = child === tabList
        || child === managementSection
        || child.classList?.contains('vacancy-header');
      if (keepVisible) return;

      if (managementActive) {
        if (!child.hidden) {
          child.hidden = true;
          child.setAttribute(MANAGEMENT_HIDDEN_ATTR, 'true');
        }
        return;
      }

      if (child.getAttribute(MANAGEMENT_HIDDEN_ATTR) === 'true') {
        child.hidden = false;
        child.removeAttribute(MANAGEMENT_HIDDEN_ATTR);
      }
    });
  }

  function historyHref(sourceToggle, vacancyId, key) {
    try {
      const url = new URL(sourceToggle.getAttribute('href') || '', window.location.origin);
      url.searchParams.set(tabContextParam(vacancyId), key);
      return url.pathname + url.search + url.hash;
    } catch {
      return sourceToggle.getAttribute('href') || '#';
    }
  }

  function installHistoryActions(panel, descriptors, vacancyId) {
    const sourceToggle = panel.querySelector('[data-vacancy-cycle-toggle]');
    if (!sourceToggle || sourceToggle.dataset.sectionTabsRehomed === 'true') return false;

    const actionLabel = String(sourceToggle.textContent || '').trim();

    descriptors.forEach((descriptor) => {
      if (!descriptor.section || descriptor.key === 'interview-management') return;
      if (descriptor.section.querySelector('[data-section-view-all]')) return;

      const actions = document.createElement('div');
      actions.className = 'candidate-vacancy-section-history-actions';
      actions.dataset.sectionViewAll = descriptor.key;

      const link = document.createElement('a');
      link.className = 'export-btn candidate-vacancy-section-view-all';
      link.href = historyHref(sourceToggle, vacancyId, descriptor.key);
      link.textContent = actionLabel;
      link.dataset.sectionHistoryAction = descriptor.key;
      actions.appendChild(link);

      const sectionHeader = descriptor.section.querySelector('.section-header');
      if (sectionHeader) sectionHeader.insertAdjacentElement('afterend', actions);
      else descriptor.section.prepend(actions);
    });

    sourceToggle.hidden = true;
    sourceToggle.dataset.sectionTabsRehomed = 'true';
    return true;
  }

  function hideCycleScopeForDateRange(panel) {
    const cycleBar = panel.querySelector('[data-vacancy-cycle-scope]');
    if (cycleBar) cycleBar.hidden = true;
  }

  function installPanel(panel) {
    if (!panel || panel.dataset.sectionTabsReady === 'true') return;
    const vacancyBody = panel.querySelector('.vacancy-body');
    if (!vacancyBody) return;

    const rangeActive = hasApplicantDateRange();
    const management = managementDescriptor(panel);
    const rawLocalDescriptors = [
      management,
      ...[...vacancyBody.children]
        .filter((element) => element.classList?.contains('section'))
        .map(sectionDescriptor)
    ].filter(Boolean);
    const localDescriptors = replaceLocalStatusDescriptorsForDateRange(rawLocalDescriptors, vacancyBody, rangeActive);
    const localKeys = new Set(localDescriptors.map((descriptor) => descriptor.key));
    const navigationDescriptors = statusNavigationDescriptors(panel, vacancyBody, localKeys);
    const descriptors = [...localDescriptors, ...navigationDescriptors]
      .sort((left, right) => descriptorOrder(left) - descriptorOrder(right));

    if (rawLocalDescriptors.length < 2) return;
    panel.dataset.sectionTabsReady = 'true';

    const rawVacancyId = String(panel.getAttribute('data-vacancy-panel') || 'vacancy');
    const vacancyId = safeId(rawVacancyId);
    const tabList = document.createElement('div');
    tabList.className = 'candidate-vacancy-section-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Secciones de la vacante');

    const tabs = descriptors.map((descriptor) => {
      const tabId = `vacancy-${vacancyId}-tab-${descriptor.key}`;

      if (descriptor.link) {
        const tab = descriptor.link;
        tab.removeAttribute('style');
        tab.id = tabId;
        tab.className = 'candidate-vacancy-section-tab';
        tab.dataset.sectionTab = descriptor.key;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'false');
        tab.tabIndex = -1;
        tabList.appendChild(tab);
        return { tab, descriptor };
      }

      const tab = document.createElement('button');
      const panelId = `vacancy-${vacancyId}-section-${descriptor.key}`;
      tab.type = 'button';
      tab.id = tabId;
      tab.className = 'candidate-vacancy-section-tab';
      tab.dataset.sectionTab = descriptor.key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panelId);
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;

      const label = document.createElement('span');
      label.textContent = descriptor.label;
      tab.appendChild(label);

      if (descriptor.count) {
        const count = document.createElement('span');
        count.className = 'candidate-vacancy-section-tab-count';
        count.textContent = descriptor.count;
        tab.appendChild(count);
      }

      descriptor.section.id = panelId;
      descriptor.section.classList.add('candidate-vacancy-section-panel');
      descriptor.section.setAttribute('role', 'tabpanel');
      descriptor.section.setAttribute('aria-labelledby', tabId);
      descriptor.section.hidden = true;

      tabList.appendChild(tab);
      return { tab, descriptor };
    });

    const vacancyHeader = panel.querySelector('.vacancy-header');
    if (vacancyHeader) vacancyHeader.insertAdjacentElement('afterend', tabList);
    else panel.prepend(tabList);
    installDateRangeIntegration(panel, tabList, rawVacancyId);

    const activate = (targetIndex, options = {}) => {
      const target = tabs[targetIndex];
      if (!target?.descriptor?.section) return;
      const activeKey = target.descriptor.key;
      tabs.forEach(({ tab, descriptor }, index) => {
        const selected = index === targetIndex && Boolean(descriptor.section);
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
        if (descriptor.section) descriptor.section.hidden = !selected;
      });
      updateManagementLayout(panel, tabList, management?.section || null, activeKey);
      updateContextualActions(panel, activeKey);
      placeDateRangeControl(panel, tabList);
      if (target.descriptor.remoteHref) {
        loadRemoteStatusSection(target.descriptor, target.tab, rawVacancyId);
      }
      if (options.focus) target.tab.focus();
    };

    const focusTab = (targetIndex) => {
      const normalizedIndex = (targetIndex + tabs.length) % tabs.length;
      tabs.forEach(({ tab }, index) => { tab.tabIndex = index === normalizedIndex ? 0 : -1; });
      tabs[normalizedIndex].tab.focus();
    };

    tabs.forEach(({ tab, descriptor }, index) => {
      if (descriptor.section) tab.addEventListener('click', () => activate(index));
      tab.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowLeft') nextIndex = index - 1;
        if (event.key === 'ArrowRight') nextIndex = index + 1;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        focusTab(nextIndex);
      });
    });

    const requestedKey = new URL(window.location.href).searchParams.get(tabContextParam(rawVacancyId));
    const requestedIndex = tabs.findIndex(({ descriptor }) => descriptor.section && descriptor.key === requestedKey);
    const initialIndex = requestedIndex >= 0
      ? requestedIndex
      : tabs.findIndex(({ descriptor }) => Boolean(descriptor.section));
    activate(Math.max(0, initialIndex));

    if (rangeActive) {
      hideCycleScopeForDateRange(panel);
    } else if (!installHistoryActions(panel, descriptors, rawVacancyId)) {
      window.setTimeout(() => installHistoryActions(panel, descriptors, rawVacancyId), 0);
    }
  }

  function install() {
    if (window.location.pathname !== '/admin') return;
    ensureDateRangeScript();
    injectStyles();
    document.querySelectorAll('[data-vacancy-panel]').forEach(installPanel);
  }

  function scheduleInstall() {
    window.setTimeout(install, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInstall, { once: true });
  } else {
    scheduleInstall();
  }
})();