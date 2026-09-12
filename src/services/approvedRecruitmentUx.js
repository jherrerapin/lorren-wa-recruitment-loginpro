import { historicalBulkCandidateStatuses } from './vacancyDashboardSearchExpansion.js';

const SCRIPT_MARK = 'data-approved-recruitment-ux';

const RECRUITER_VACANCY_STATUS_FILTERS = Object.freeze([
  Object.freeze({ scope: 'registered', routeScope: 'registered', label: 'Registrados' }),
  Object.freeze({ scope: 'approved', routeScope: 'all', label: 'Aprobados', approvedOnly: true }),
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
  const recruiterBulkStatuses = JSON.stringify(historicalBulkCandidateStatuses('admin'));
  const devBulkStatuses = JSON.stringify(historicalBulkCandidateStatuses('dev'));

  return `
<script ${SCRIPT_MARK}>
(() => {
  const currentUrl = new URL(window.location.href);
  const approvedOnly = currentUrl.searchParams.get('approvedOnly') === '1';
  const recruiterVacancyStatusFilters = ${recruiterVacancyStatusFilters};
  const devVacancyStatusFilters = ${devVacancyStatusFilters};
  const recruiterBulkStatuses = ${recruiterBulkStatuses};
  const devBulkStatuses = ${devBulkStatuses};
  const isDevUi = Boolean(document.querySelector('a[href="/admin/monitor"]'));
  const bulkStatuses = isDevUi ? devBulkStatuses : recruiterBulkStatuses;
  const bulkStatusLabels = {
    NUEVO: 'Nuevo',
    REGISTRADO: 'Registrado',
    APROBADO: 'Aprobado',
    CONTACTADO: 'Contactado',
    RECHAZADO: 'Rechazado'
  };

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

  function candidateIdFromDetailLink(anchor) {
    if (!anchor) return '';
    const url = new URL(anchor.getAttribute('href') || '', window.location.origin);
    const prefix = '/admin/candidates/';
    if (!url.pathname.startsWith(prefix)) return '';
    const encodedCandidateId = url.pathname.slice(prefix.length);
    if (!encodedCandidateId || encodedCandidateId.includes('/')) return '';
    return decodeURIComponent(encodedCandidateId);
  }

  function buildFilteredCandidateCheckbox(candidateId) {
    const label = document.createElement('label');
    label.setAttribute('data-filtered-bulk-checkbox', candidateId);
    label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:0 8px 5px 0;font-size:11px;font-weight:700;color:var(--text-muted);cursor:pointer;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = candidateId;
    checkbox.setAttribute('data-filtered-candidate-id', candidateId);
    checkbox.setAttribute('aria-label', 'Seleccionar candidato para cambio de estado');

    const text = document.createElement('span');
    text.textContent = 'Seleccionar';
    label.append(checkbox, text);
    return label;
  }

  function installFilteredBulkStatusControls(table) {
    const vacancyId = String(currentUrl.searchParams.get('vacancyId') || '').trim();
    const activeStatus = String(currentUrl.searchParams.get('status') || '').trim();
    if (!vacancyId || !activeStatus || activeStatus === 'inbox' || !bulkStatuses.length) return;
    if (document.querySelector('[data-filtered-vacancy-bulk-status="' + vacancyId + '"]')) return;

    const candidateIds = new Set();
    const rows = Array.from(table.tBodies?.[0]?.rows || []);
    rows.forEach((row) => {
      if (row.hidden || row.querySelector('.badge-contratado')) return;
      const detailLink = row.querySelector('a.link-detail[href]');
      const candidateId = candidateIdFromDetailLink(detailLink);
      if (!candidateId || candidateIds.has(candidateId)) return;
      const mount = row.querySelector('td:nth-child(2)') || row.querySelector('td');
      if (!mount) return;
      candidateIds.add(candidateId);
      mount.prepend(buildFilteredCandidateCheckbox(candidateId));
    });

    if (!candidateIds.size) return;

    const toolbar = document.createElement('form');
    toolbar.setAttribute('data-filtered-vacancy-bulk-status', vacancyId);
    toolbar.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--border);border-bottom:0;background:#f8fafc;';

    const selectAllLabel = document.createElement('label');
    selectAllLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--navy);cursor:pointer;';
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.setAttribute('data-filtered-select-all', vacancyId);
    const selectAllText = document.createElement('span');
    selectAllText.textContent = 'Seleccionar visibles';
    selectAllLabel.append(selectAll, selectAllText);

    const selectedCount = document.createElement('span');
    selectedCount.className = 'filter-note';
    selectedCount.setAttribute('data-filtered-selected-count', vacancyId);
    selectedCount.textContent = '0 seleccionados';

    const statusSelect = document.createElement('select');
    statusSelect.setAttribute('aria-label', 'Nuevo estado para seleccionados');
    statusSelect.style.cssText = 'min-height:34px;border:1px solid var(--border);border-radius:6px;padding:5px 9px;background:var(--surface);color:var(--navy);';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Cambiar estado a...';
    statusSelect.appendChild(placeholder);
    bulkStatuses.forEach((status) => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = bulkStatusLabels[status] || status;
      statusSelect.appendChild(option);
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'export-btn';
    submit.style.cursor = 'pointer';
    submit.disabled = true;
    submit.textContent = 'Aplicar a seleccionados';

    const feedback = document.createElement('span');
    feedback.className = 'filter-note';
    feedback.setAttribute('data-filtered-bulk-feedback', vacancyId);
    feedback.textContent = 'Contratados se gestionan individualmente.';

    toolbar.append(selectAllLabel, selectedCount, statusSelect, submit, feedback);
    table.insertAdjacentElement('beforebegin', toolbar);

    const allCandidateCheckboxes = () => Array.from(table.querySelectorAll('input[data-filtered-candidate-id]'));
    const visibleCandidateCheckboxes = () => allCandidateCheckboxes().filter((checkbox) => {
      const row = checkbox.closest('tr');
      return Boolean(row) && !row.hidden;
    });
    const syncControls = () => {
      const checkboxes = visibleCandidateCheckboxes();
      const selected = checkboxes.filter((checkbox) => checkbox.checked);
      selectedCount.textContent = selected.length + ' seleccionado' + (selected.length === 1 ? '' : 's');
      selectAll.checked = checkboxes.length > 0 && selected.length === checkboxes.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < checkboxes.length;
      submit.disabled = selected.length === 0 || !statusSelect.value;
    };

    allCandidateCheckboxes().forEach((checkbox) => checkbox.addEventListener('change', syncControls));
    statusSelect.addEventListener('change', syncControls);
    selectAll.addEventListener('change', () => {
      visibleCandidateCheckboxes().forEach((checkbox) => { checkbox.checked = selectAll.checked; });
      syncControls();
    });

    async function applyCandidateStatus(candidateId, status, returnTo) {
      const body = new URLSearchParams();
      body.set('status', status);
      body.set('returnTo', returnTo);
      const response = await fetch('/admin/candidates/' + encodeURIComponent(candidateId) + '/status', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      });
      const finalUrl = new URL(response.url || window.location.href, window.location.origin);
      const detailPrefix = '/admin/candidates/';
      const finalCandidateId = finalUrl.pathname.startsWith(detailPrefix)
        ? finalUrl.pathname.slice(detailPrefix.length)
        : '';
      return response.ok && Boolean(finalCandidateId) && !finalCandidateId.includes('/');
    }

    async function triggerConfiguredApprovedOutreach(candidateId) {
      const body = new URLSearchParams();
      body.append('candidateIds', candidateId);
      body.set('vacancyId', vacancyId);
      const response = await fetch('/admin/outreach/approved/prepare', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      });
      if (!response.ok) return false;

      const verificationUrl = new URL('/admin/outreach/approved/window-status', window.location.origin);
      verificationUrl.searchParams.set('candidateIds', candidateId);
      const verification = await fetch(verificationUrl.pathname + verificationUrl.search, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!verification.ok) return false;
      const payload = await verification.json().catch(() => null);
      if (!payload?.ok || !Array.isArray(payload.candidates)) return false;
      return !payload.candidates.some((candidate) => candidate?.candidateId === candidateId);
    }

    toolbar.addEventListener('submit', async (event) => {
      event.preventDefault();
      const selectedIds = visibleCandidateCheckboxes()
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value);
      const status = statusSelect.value;
      if (!selectedIds.length || !bulkStatuses.includes(status)) return;

      submit.disabled = true;
      selectAll.disabled = true;
      statusSelect.disabled = true;
      allCandidateCheckboxes().forEach((checkbox) => { checkbox.disabled = true; });

      const autoOutreachOnApproval = status === 'APROBADO'
        && ['registered', 'missing_cv_complete'].includes(activeStatus);
      let completed = 0;
      let contacted = 0;
      let approvedPendingOutreach = 0;
      let failed = 0;
      const returnTo = currentUrl.pathname + currentUrl.search;

      for (let index = 0; index < selectedIds.length; index += 1) {
        const candidateId = selectedIds[index];
        feedback.textContent = 'Procesando ' + (index + 1) + ' de ' + selectedIds.length + '...';
        try {
          const statusUpdated = await applyCandidateStatus(candidateId, status, returnTo);
          if (!statusUpdated) {
            failed += 1;
            continue;
          }

          if (autoOutreachOnApproval) {
            const outreachCompleted = await triggerConfiguredApprovedOutreach(candidateId);
            if (outreachCompleted) contacted += 1;
            else approvedPendingOutreach += 1;
            continue;
          }

          completed += 1;
        } catch (_error) {
          if (autoOutreachOnApproval) approvedPendingOutreach += 1;
          else failed += 1;
        }
      }

      const target = new URL(window.location.href);
      target.searchParams.delete('success');
      target.searchParams.delete('error');

      if (autoOutreachOnApproval) {
        if (contacted > 0) {
          target.searchParams.set(
            'success',
            contacted + ' candidato' + (contacted === 1 ? '' : 's') + ' aprobado' + (contacted === 1 ? '' : 's')
              + ', con citación aceptada por Meta y movido' + (contacted === 1 ? '' : 's') + ' a Contactados.'
          );
        }
        const pendingTotal = approvedPendingOutreach + failed;
        if (pendingTotal > 0) {
          target.searchParams.set(
            'error',
            approvedPendingOutreach
              ? approvedPendingOutreach + ' candidato' + (approvedPendingOutreach === 1 ? '' : 's')
                + ' quedó' + (approvedPendingOutreach === 1 ? '' : 'aron')
                + ' en Aprobados porque no se confirmó la citación. Revisa Aprobados antes de reintentar.'
              : failed + ' candidato' + (failed === 1 ? '' : 's') + ' no pudo cambiar a Aprobado.'
          );
        }
      } else if (failed > 0) {
        target.searchParams.set(
          'error',
          completed
            ? 'Se actualizaron ' + completed + ' de ' + selectedIds.length + ' registros. Revisa el listado antes de reintentar.'
            : 'No fue posible aplicar el cambio masivo. Ningún registro fue confirmado como actualizado.'
        );
      } else {
        target.searchParams.set('success', completed + ' registro' + (completed === 1 ? '' : 's') + ' actualizado' + (completed === 1 ? '' : 's') + ' a ' + (bulkStatusLabels[status] || status) + '.');
      }

      window.location.assign(target.pathname + target.search);
    });

    syncControls();
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
      url.searchParams.set('status', 'all');
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
        if (!url || url.searchParams.get('status') !== 'all') return;
        url.searchParams.set('approvedOnly', '1');
        anchor.href = url.pathname + url.search;
      });

      const summary = Array.from(document.querySelectorAll('p')).find((node) => /^Mostrando\s+\d+\s+candidato/i.test(node.textContent.trim()));
      if (summary) summary.textContent = 'Mostrando ' + visible + ' candidato(s) aprobados';
    }

    installFilteredBulkStatusControls(legacyTable);
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

    const vacancyHeader = panel.querySelector('.vacancy-header');
    const headerTarget = panel.querySelector('.vacancy-badges') || vacancyHeader;
    if (!headerTarget) return;
    outreachLink.dataset.approvedOutreachHeaderLink = vacancyId;
    outreachLink.style.whiteSpace = 'nowrap';
    headerTarget.appendChild(outreachLink);
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
