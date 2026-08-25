const SCRIPT_MARK = 'data-approved-recruitment-ux';

function approvedRecruitmentScript() {
  return `
<script ${SCRIPT_MARK}>
(() => {
  const currentUrl = new URL(window.location.href);
  const approvedOnly = currentUrl.searchParams.get('approvedOnly') === '1';

  function adminUrlFromAnchor(anchor) {
    try {
      return new URL(anchor.href, window.location.origin);
    } catch {
      return null;
    }
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
