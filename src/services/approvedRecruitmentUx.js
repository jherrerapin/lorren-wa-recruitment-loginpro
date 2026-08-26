const SCRIPT_MARK = 'data-approved-recruitment-ux';

const RECRUITER_VACANCY_STATUS_FILTERS = Object.freeze([
  Object.freeze({ scope: 'registered', routeScope: 'registered', label: 'Registrados' }),
  Object.freeze({ scope: 'approved', routeScope: 'registered', label: 'Aprobados', approvedOnly: true }),
  Object.freeze({ scope: 'contacted', routeScope: 'contacted', label: 'Contactados' }),
  Object.freeze({ scope: 'contracted', routeScope: 'contracted', label: 'Contratados' }),
  Object.freeze({ scope: 'rejected', routeScope: 'rejected', label: 'Rechazados' })
]);

const DEV_NEW_VACANCY_STATUS_FILTER = Object.freeze({
  scope: 'new',
  routeScope: 'new',
  label: 'Nuevos'
});

export function vacancyStatusFilterDefinitions(role = 'admin') {
  const filters = RECRUITER_VACANCY_STATUS_FILTERS.map((filter) => ({ ...filter }));
  if (String(role || '').trim().toLowerCase() === 'dev') {
    filters.splice(2, 0, { ...DEV_NEW_VACANCY_STATUS_FILTER });
  }
  return filters;
}

function approvedRecruitmentScript() {
  const recruiterVacancyStatusFilters = JSON.stringify(vacancyStatusFilterDefinitions('admin'));
  const devVacancyStatusFilters = JSON.stringify(vacancyStatusFilterDefinitions('dev'));

  return `
<script ${SCRIPT_MARK}>
(() => {
  const currentUrl = new URL(window.location.href);
  const approvedOnly = currentUrl.searchParams.get('approvedOnly') === '1';
  const recruiterVacancyStatusFilters = ${recruiterVacancyStatusFilters};
  const devVacancyStatusFilters = ${devVacancyStatusFilters};
  const isDevUi = Boolean(document.querySelector('a[href="/admin/monitor"]'));

  function adminUrlFromAnchor(anchor) {
    try {
      return new URL(anchor.href, window.location.origin);
    } catch {
      return null;
    }
  }

  function installVacancyStatusFilters(panel, vacancyId) {
    if (panel.querySelector('[data-vacancy-status-filters]')) return;

    const filters = isDevUi ? devVacancyStatusFilters : recruiterVacancyStatusFilters;
    const filterBar = document.createElement('div');
    filterBar.dataset.vacancyStatusFilters = vacancyId;
    filterBar.setAttribute('aria-label', 'Filtrar registros de esta vacante por estado');
    Object.assign(filterBar.style, {
      display: 'flex',
      gap: '6px',
      flexWrap: 'wrap',
      padding: '10px 18px',
      borderBottom: '1px solid var(--border-soft)',
      background: 'var(--surface)'
    });

    filters.forEach((filter) => {
      const url = new URL('/admin', window.location.origin);
      url.searchParams.set('status', filter.routeScope);
      url.searchParams.set('vacancyId', vacancyId);
      if (filter.approvedOnly) url.searchParams.set('approvedOnly', '1');

      const link = document.createElement('a');
      link.href = url.pathname + url.search;
      link.textContent = filter.label;
      link.dataset.vacancyStatusScope = filter.scope;
      Object.assign(link.style, {
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        color: 'var(--navy)',
        padding: '6px 14px',
        borderRadius: '20px',
        fontSize: '13px',
        fontWeight: '600',
        textDecoration: 'none'
      });
      filterBar.appendChild(link);
    });

    const header = panel.querySelector('.vacancy-header');
    if (header) header.insertAdjacentElement('afterend', filterBar);
    else panel.prepend(filterBar);
  }

  const legacyTable = document.getElementById('legacy-candidates-table');
  if (legacyTable) {
    const adminLinks = Array.from(document.querySelectorAll('a[href^="/admin?"]'));
    const registeredLink = adminLinks.find((anchor) => {
      const url = adminUrlFromAnchor(anchor);
      return url?.pathname === '/admin'
        && url.searchParams.get('status') === 'registered'
        && anchor.textContent.trim() === 'Registrados';
    });

    let approvedLink = document.querySelector('[data-approved-filter-tab]');
    if (registeredLink && !approvedLink) {
      approvedLink = registeredLink.cloneNode(true);
      const url = adminUrlFromAnchor(registeredLink) || new URL('/admin', window.location.origin);
      url.searchParams.set('status', 'registered');
      url.searchParams.set('approvedOnly', '1');
      approvedLink.href = url.pathname + url.search;
      approvedLink.textContent = 'Aprobados';
      approvedLink.dataset.approvedFilterTab = 'true';
      approvedLink.style.background = 'var(--surface)';
      approvedLink.style.color = 'var(--navy)';
      registeredLink.insertAdjacentElement('afterend', approvedLink);
    }

    if (approvedOnly) {
      let visible = 0;
      const rows = Array.from(legacyTable.tBodies?.[0]?.rows || []);
      rows.forEach((row) => {
        const isApproved = Boolean(row.querySelector('.badge-aprobado'));
        row.hidden = !isApproved;
        if (isApproved) visible += 1;
      });

      if (registeredLink) {
        registeredLink.style.background = 'var(--surface)';
        registeredLink.style.color = 'var(--navy)';
      }
      if (approvedLink) {
        approvedLink.style.background = 'var(--navy)';
        approvedLink.style.color = '#fff';
      }

      document.querySelectorAll('form[method="get"][action="/admin"]').forEach((form) => {
        if (form.querySelector('input[name="approvedOnly"]')) return;
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'approvedOnly';
        hidden.value = '1';
        form.appendChild(hidden);
      });

      document.querySelectorAll('a[href^="/admin?"]').forEach((anchor) => {
        if (!/^Limpiar/.test(anchor.textContent.trim())) return;
        const url = adminUrlFromAnchor(anchor);
        if (!url || url.searchParams.get('status') !== 'registered') return;
        url.searchParams.set('approvedOnly', '1');
        anchor.href = url.pathname + url.search;
      });

      const summary = Array.from(document.querySelectorAll('p')).find((node) => /^Mostrando\s+\d+\s+candidato/i.test(node.textContent.trim()));
      if (summary) summary.textContent = 'Mostrando ' + visible + ' candidato(s) aprobados';
    }
  }

  document.querySelectorAll('[data-vacancy-panel]').forEach((panel) => {
    const vacancyId = String(panel.dataset.vacancyPanel || '').trim();
    if (!vacancyId) return;

    installVacancyStatusFilters(panel, vacancyId);

    const outreachLink = Array.from(panel.querySelectorAll('a')).find((anchor) => {
      const url = adminUrlFromAnchor(anchor);
      return url?.pathname === '/admin/outreach/approved';
    });
    if (!outreachLink) return;

    const vacancyRole = panel.querySelector('.vacancy-role')?.textContent || '';
    const city = vacancyRole.includes('—') ? vacancyRole.split('—').pop().trim() : '';
    const url = new URL('/admin/outreach/approved', window.location.origin);
    if (city) url.searchParams.set('city', city);
    url.searchParams.set('vacancyId', vacancyId);
    outreachLink.href = url.pathname + url.search;
  });
})();
</script>`;
}

export function enhanceApprovedRecruitmentUx(html) {
  if (typeof html !== 'string') return html;
  if (html.includes(SCRIPT_MARK)) return html;
  if (!html.includes('legacy-candidates-table') && !html.includes('data-vacancy-panel')) return html;
  if (!/<\/body>/i.test(html)) return html;
  return html.replace(/<\/body>/i, `${approvedRecruitmentScript()}\n</body>`);
}
