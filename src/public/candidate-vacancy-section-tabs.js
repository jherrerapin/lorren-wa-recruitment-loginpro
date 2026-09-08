'use strict';

(() => {
  const STYLE_ID = 'candidate-vacancy-section-tabs-style';
  const MANAGEMENT_HIDDEN_ATTR = 'data-section-tabs-management-hidden';
  const EXPORT_SCOPE_BY_TAB = Object.freeze({
    registered: 'registered',
    'missing-cv': 'missing_cv_complete',
    approved: 'approved'
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
    }
  ];

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
      .candidate-vacancy-section-tab{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;border:1px solid #e1e4e8;border-bottom:0;border-radius:8px 8px 0 0;padding:8px 13px;background:#f9fafb;color:#64748b;font:inherit;font-size:12px;font-weight:700;cursor:pointer;min-height:38px}
      .candidate-vacancy-section-tab:hover{background:#f3f4f6;color:#1e2d3d}
      .candidate-vacancy-section-tab[aria-selected="true"]{background:#fff;color:#1e2d3d;border-color:#cbd5e1;box-shadow:inset 0 2px 0 #0d7a6b}
      .candidate-vacancy-section-tab:focus-visible{outline:2px solid rgba(13,122,107,.24);outline-offset:-2px}
      .candidate-vacancy-section-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#eef2f7;color:#475569;font-size:10px;font-weight:800}
      .candidate-vacancy-section-tab[aria-selected="true"] .candidate-vacancy-section-tab-count{background:#e6f4f1;color:#0d5f54}
      .candidate-vacancy-section-panel[hidden]{display:none!important}
      @media(max-width:768px){
        .candidate-vacancy-section-tabs{padding:10px 14px 0;gap:5px}
        .candidate-vacancy-section-tab{padding:9px 11px;min-height:42px}
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

  function exportScope(anchor) {
    try {
      return new URL(anchor.getAttribute('href') || '', window.location.origin).searchParams.get('scope');
    } catch {
      return null;
    }
  }

  function updateContextualActions(panel, activeKey) {
    const expectedScope = EXPORT_SCOPE_BY_TAB[activeKey] || null;
    const managementActive = activeKey === 'interview-management';

    panel.querySelectorAll('.export-bar a[href*="/admin/export?"]').forEach((anchor) => {
      const scope = exportScope(anchor);
      anchor.hidden = managementActive || !(scope === 'all' || (expectedScope && scope === expectedScope));
    });

    panel.querySelectorAll('a[href^="/admin/outreach/approved"]').forEach((anchor) => {
      anchor.hidden = activeKey !== 'approved';
    });
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

  function installPanel(panel) {
    if (!panel || panel.dataset.sectionTabsReady === 'true') return;
    const vacancyBody = panel.querySelector('.vacancy-body');
    if (!vacancyBody) return;

    const management = managementDescriptor(panel);
    const descriptors = [
      management,
      ...[...vacancyBody.children]
        .filter((element) => element.classList?.contains('section'))
        .map(sectionDescriptor)
    ].filter(Boolean);

    if (descriptors.length < 2) return;
    panel.dataset.sectionTabsReady = 'true';

    const vacancyId = safeId(panel.getAttribute('data-vacancy-panel'));
    const tabList = document.createElement('div');
    tabList.className = 'candidate-vacancy-section-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Secciones de la vacante');

    const tabs = descriptors.map((descriptor, index) => {
      const tab = document.createElement('button');
      const tabId = `vacancy-${vacancyId}-tab-${descriptor.key}`;
      const panelId = `vacancy-${vacancyId}-section-${descriptor.key}`;

      tab.type = 'button';
      tab.id = tabId;
      tab.className = 'candidate-vacancy-section-tab';
      tab.dataset.sectionTab = descriptor.key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panelId);
      tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
      tab.tabIndex = index === 0 ? 0 : -1;

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
      descriptor.section.hidden = index !== 0;

      tabList.appendChild(tab);
      return { tab, descriptor };
    });

    const vacancyHeader = panel.querySelector('.vacancy-header');
    if (vacancyHeader) vacancyHeader.insertAdjacentElement('afterend', tabList);
    else panel.prepend(tabList);

    const activate = (targetIndex, options = {}) => {
      const normalizedIndex = Math.max(0, Math.min(targetIndex, tabs.length - 1));
      const activeKey = tabs[normalizedIndex].descriptor.key;
      tabs.forEach(({ tab, descriptor }, index) => {
        const selected = index === normalizedIndex;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
        descriptor.section.hidden = !selected;
      });
      updateManagementLayout(panel, tabList, management?.section || null, activeKey);
      updateContextualActions(panel, activeKey);
      if (options.focus) tabs[normalizedIndex].tab.focus();
    };

    tabs.forEach(({ tab }, index) => {
      tab.addEventListener('click', () => activate(index));
      tab.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowLeft') nextIndex = index === 0 ? tabs.length - 1 : index - 1;
        if (event.key === 'ArrowRight') nextIndex = index === tabs.length - 1 ? 0 : index + 1;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        activate(nextIndex, { focus: true });
      });
    });

    activate(0);
  }

  function install() {
    if (window.location.pathname !== '/admin') return;
    injectStyles();
    document.querySelectorAll('[data-vacancy-panel]').forEach(installPanel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
