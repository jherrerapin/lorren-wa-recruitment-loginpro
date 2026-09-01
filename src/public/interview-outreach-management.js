(() => {
  'use strict';

  const API_BASE = '/admin/interview-management';
  const INVITATION_OPTIONS = [
    ['PENDING', 'Pendiente'],
    ['CONFIRMED', 'Confirmó'],
    ['DECLINED', 'No asistirá']
  ];
  const ATTENDANCE_OPTIONS = [
    ['PENDING', 'Pendiente'],
    ['ATTENDED', 'Asistió'],
    ['NO_SHOW', 'No asistió']
  ];

  function addStyles() {
    if (document.getElementById('interview-management-styles')) return;
    const style = document.createElement('style');
    style.id = 'interview-management-styles';
    style.textContent = `
      .im-panel{grid-column:1/-1;border:1px solid #dbe5ef;border-radius:12px;background:#f8fbff;padding:12px 14px;margin-top:8px}
      .im-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
      .im-field{display:flex;flex-direction:column;gap:5px}
      .im-field label,.im-label{font-size:12px;font-weight:700;color:#526477}
      .im-field select,.im-field input,.im-field textarea,.im-input{width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:9px 10px;font:inherit;color:#1f2937}
      .im-field textarea{min-height:96px;resize:vertical}
      .im-meta{font-size:12px;color:#64748b;margin-top:5px;line-height:1.35}
      .im-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
      .im-title strong{color:#243b53}
      .im-chip{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;background:#e8f1fb;color:#28557a}
      .im-chip-success{background:#dcfce7;color:#166534}
      .im-chip-warn{background:#fef3c7;color:#92400e}
      .im-chip-danger{background:#fee2e2;color:#991b1b}
      .im-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
      .im-btn{border:0;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer;background:#2563eb;color:#fff}
      .im-btn:disabled{opacity:.6;cursor:default}
      .im-btn-secondary{background:#fff;color:#334155;border:1px solid #cbd5e1}
      .im-plus{width:38px;height:38px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-size:24px;line-height:1;cursor:pointer}
      .im-inline-add{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;margin-top:10px}
      .im-status{font-size:12px;font-weight:700;color:#475569;min-height:18px}
      .im-status[data-kind="success"]{color:#15803d}.im-status[data-kind="error"]{color:#b91c1c}
      .im-observation-toggle{display:flex;align-items:center;gap:8px;margin:12px 0 8px;color:#334155;font-weight:700;font-size:13px}
      .im-observation-toggle input{width:auto}
      .im-complementary{display:grid;gap:10px;margin-top:12px}
      .im-section-title{font-size:14px;font-weight:800;color:#243b53;margin:18px 0 8px}
      .im-detail-card{border-top:3px solid #2563eb}
      @media(max-width:680px){.im-grid{grid-template-columns:1fr}.im-inline-add{grid-template-columns:1fr}.im-plus{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function selectFor(options, value) {
    const select = document.createElement('select');
    for (const [optionValue, label] of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = label;
      option.selected = optionValue === value;
      select.appendChild(option);
    }
    return select;
  }

  function field(label, control) {
    const wrapper = element('div', 'im-field');
    const labelNode = element('label', '', label);
    wrapper.append(labelNode, control);
    return wrapper;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(date);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `request_failed_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setStatus(node, message, kind = '') {
    if (!node) return;
    node.textContent = message || '';
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  function invitationMeta(invitation = {}) {
    if (invitation.source === 'WHATSAPP') {
      return invitation.updatedAt
        ? `Automático por WhatsApp · ${formatDate(invitation.updatedAt)}`
        : 'Automático por WhatsApp';
    }
    if (invitation.source === 'MANUAL') {
      const actor = invitation.updatedByLabel ? ` por ${invitation.updatedByLabel}` : '';
      const at = invitation.updatedAt ? ` · ${formatDate(invitation.updatedAt)}` : '';
      return `Registrado manualmente${actor}${at}`;
    }
    return 'Sin confirmación registrada.';
  }

  function attendanceMeta(attendance = {}) {
    if (!attendance.updatedAt) return 'Se registra el día de la entrevista.';
    const actor = attendance.updatedByLabel ? ` por ${attendance.updatedByLabel}` : '';
    return `Actualizado${actor} · ${formatDate(attendance.updatedAt)}`;
  }

  async function persistStatus(candidateId, kind, value) {
    const endpoint = kind === 'invitation' ? 'invitation' : 'attendance';
    return api(`/candidates/${encodeURIComponent(candidateId)}/${endpoint}`, {
      method: 'POST',
      body: JSON.stringify({ status: value })
    });
  }

  function renderDashboardManagement(row, candidateId, entry) {
    if (row.querySelector('[data-im-dashboard-panel]')) return;
    const panel = element('div', 'im-panel');
    panel.dataset.imDashboardPanel = candidateId;
    const grid = element('div', 'im-grid');

    const invitationSelect = selectFor(INVITATION_OPTIONS, entry.invitation?.status || 'PENDING');
    const invitationField = field('Confirmación de citación', invitationSelect);
    const invitationHelp = element('div', 'im-meta', invitationMeta(entry.invitation));
    invitationField.appendChild(invitationHelp);

    const attendanceSelect = selectFor(ATTENDANCE_OPTIONS, entry.attendance?.status || 'PENDING');
    const attendanceField = field('Asistencia real', attendanceSelect);
    const attendanceHelp = element('div', 'im-meta', attendanceMeta(entry.attendance));
    attendanceField.appendChild(attendanceHelp);

    const evaluation = element('div', 'im-field');
    evaluation.appendChild(element('label', '', 'Evaluación'));
    if (entry.evaluation?.rating == null) {
      evaluation.appendChild(element('div', 'im-meta', 'Sin calificación registrada.'));
    } else {
      const band = entry.evaluation?.band?.label || 'Sin clasificación';
      evaluation.appendChild(element('span', 'im-chip', `${entry.evaluation.rating} / 5 · ${band}`));
      if (entry.evaluation.updatedByLabel || entry.evaluation.updatedAt) {
        evaluation.appendChild(element(
          'div',
          'im-meta',
          `${entry.evaluation.updatedByLabel ? `Por ${entry.evaluation.updatedByLabel}` : 'Actualizado'}${entry.evaluation.updatedAt ? ` · ${formatDate(entry.evaluation.updatedAt)}` : ''}`
        ));
      }
    }

    const status = element('div', 'im-status');
    const onStatusChange = async (select, kind, metaNode) => {
      select.disabled = true;
      setStatus(status, 'Guardando...');
      try {
        const result = await persistStatus(candidateId, kind, select.value);
        const current = kind === 'invitation' ? result.management.invitation : result.management.attendance;
        metaNode.textContent = kind === 'invitation' ? invitationMeta(current) : attendanceMeta(current);
        setStatus(status, 'Cambio guardado.', 'success');
      } catch (error) {
        setStatus(status, 'No fue posible guardar el cambio.', 'error');
      } finally {
        select.disabled = false;
      }
    };

    invitationSelect.addEventListener('change', () => onStatusChange(invitationSelect, 'invitation', invitationHelp));
    attendanceSelect.addEventListener('change', () => onStatusChange(attendanceSelect, 'attendance', attendanceHelp));

    grid.append(invitationField, attendanceField, evaluation);
    panel.append(grid, status);
    row.appendChild(panel);
  }

  function candidateIdFromRow(row) {
    const link = row.querySelector('a[href*="/admin/candidates/"]');
    if (!link) return null;
    const match = /\/admin\/candidates\/([^/?#]+)/.exec(link.getAttribute('href') || '');
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function enhanceDashboardSections() {
    const sections = [...document.querySelectorAll('[data-interview-outreach-attendance]')];
    for (const section of sections) {
      const vacancyId = section.getAttribute('data-interview-outreach-attendance');
      if (!vacancyId) continue;
      try {
        const response = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
        const byCandidate = new Map((response.entries || []).map((entry) => [entry.candidateId, entry]));
        section.querySelectorAll('.candidate-row').forEach((row) => {
          const candidateId = candidateIdFromRow(row);
          const entry = candidateId ? byCandidate.get(candidateId) : null;
          if (candidateId && entry) renderDashboardManagement(row, candidateId, entry);
        });
      } catch (error) {
        const note = element('div', 'im-status', 'No fue posible cargar la gestión de entrevistas.');
        note.dataset.kind = 'error';
        section.appendChild(note);
      }
    }
  }

  function detailCandidateId() {
    const match = /^\/admin\/candidates\/([^/]+)\/?$/.exec(window.location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function ratingChip(evaluation = {}) {
    if (evaluation.rating == null) return element('span', 'im-chip', 'Sin calificar');
    const band = evaluation.band?.label || 'Sin clasificación';
    let cls = 'im-chip';
    if (evaluation.band?.key === 'OPTIONED') cls += ' im-chip-success';
    else if (evaluation.band?.key === 'RESERVE') cls += ' im-chip-warn';
    else if (evaluation.band?.key === 'DISQUALIFIED') cls += ' im-chip-danger';
    return element('span', cls, `${evaluation.rating} / 5 · ${band}`);
  }

  function findInterviewCard() {
    return [...document.querySelectorAll('.card')]
      .find((card) => card.querySelector('h2')?.textContent?.trim() === 'Entrevistas') || null;
  }

  function renderDetailCard(candidateId, response) {
    const existing = document.querySelector('[data-im-detail-card]');
    if (existing) existing.remove();

    const management = response.management || {};
    const card = element('div', 'card im-detail-card');
    card.dataset.imDetailCard = candidateId;
    card.appendChild(element('h2', '', 'Gestión de entrevista'));

    const intro = element(
      'p',
      'im-meta',
      'La confirmación previa y la asistencia real se registran por separado. La calificación orienta la revisión humana y no contrata ni rechaza automáticamente.'
    );
    intro.style.marginBottom = '14px';
    card.appendChild(intro);

    const stateGrid = element('div', 'im-grid');
    const invitationSelect = selectFor(INVITATION_OPTIONS, management.invitation?.status || 'PENDING');
    const invitationField = field('Confirmación de citación', invitationSelect);
    const invitationHelp = element('div', 'im-meta', invitationMeta(management.invitation));
    invitationField.appendChild(invitationHelp);

    const attendanceSelect = selectFor(ATTENDANCE_OPTIONS, management.attendance?.status || 'PENDING');
    const attendanceField = field('Asistencia real', attendanceSelect);
    const attendanceHelp = element('div', 'im-meta', attendanceMeta(management.attendance));
    attendanceField.appendChild(attendanceHelp);

    const classificationField = element('div', 'im-field');
    classificationField.appendChild(element('label', '', 'Clasificación actual'));
    classificationField.appendChild(ratingChip(management.evaluation));
    const reviewMeta = element(
      'div',
      'im-meta',
      management.evaluation?.updatedAt
        ? `${management.evaluation.updatedByLabel ? `Por ${management.evaluation.updatedByLabel}` : 'Actualizado'} · ${formatDate(management.evaluation.updatedAt)}`
        : 'Se calcula al guardar una calificación.'
    );
    classificationField.appendChild(reviewMeta);
    stateGrid.append(invitationField, attendanceField, classificationField);
    card.appendChild(stateGrid);

    const status = element('div', 'im-status');
    status.style.marginTop = '8px';

    const persistAndRefresh = async (select, kind) => {
      select.disabled = true;
      setStatus(status, 'Guardando...');
      try {
        await persistStatus(candidateId, kind, select.value);
        const refreshed = await api(`/candidates/${encodeURIComponent(candidateId)}`);
        renderDetailCard(candidateId, refreshed);
      } catch (error) {
        setStatus(status, 'No fue posible guardar el cambio.', 'error');
        select.disabled = false;
      }
    };
    invitationSelect.addEventListener('change', () => persistAndRefresh(invitationSelect, 'invitation'));
    attendanceSelect.addEventListener('change', () => persistAndRefresh(attendanceSelect, 'attendance'));

    card.appendChild(element('div', 'im-section-title', 'Evaluación'));
    const ratingInput = document.createElement('input');
    ratingInput.type = 'number';
    ratingInput.min = '1';
    ratingInput.max = '5';
    ratingInput.step = '0.01';
    ratingInput.inputMode = 'decimal';
    ratingInput.value = management.evaluation?.rating ?? '';
    ratingInput.placeholder = '1.00 a 5.00';
    const ratingField = field('Calificación decimal', ratingInput);
    ratingField.appendChild(element('div', 'im-meta', '1–2.99 Descalificado · 3–3.59 Reserva · 3.60–5 Opcionado a contratar.'));
    card.appendChild(ratingField);

    const observationToggle = element('label', 'im-observation-toggle');
    const observationCheckbox = document.createElement('input');
    observationCheckbox.type = 'checkbox';
    observationCheckbox.checked = Boolean(management.evaluation?.observationEnabled);
    observationToggle.append(observationCheckbox, document.createTextNode(' Agregar observación de entrevista'));
    card.appendChild(observationToggle);

    const observationArea = document.createElement('textarea');
    observationArea.placeholder = 'Observación de la entrevista';
    observationArea.value = management.evaluation?.observation || '';
    const observationField = field('Observación', observationArea);
    observationField.style.display = observationCheckbox.checked ? '' : 'none';
    observationCheckbox.addEventListener('change', () => {
      observationField.style.display = observationCheckbox.checked ? '' : 'none';
      if (!observationCheckbox.checked) observationArea.value = '';
    });
    card.appendChild(observationField);

    card.appendChild(element('div', 'im-section-title', 'Información complementaria'));
    const complementary = element('div', 'im-complementary');
    const complementaryInputs = [];
    for (const item of management.complementaryFields || []) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = item.value || '';
      input.placeholder = `Valor para ${item.label}`;
      complementaryInputs.push({ fieldId: item.id, input });
      const wrapper = field(item.label, input);
      if (item.updatedAt || item.updatedByLabel) {
        wrapper.appendChild(element(
          'div',
          'im-meta',
          `${item.updatedByLabel ? `Por ${item.updatedByLabel}` : 'Actualizado'}${item.updatedAt ? ` · ${formatDate(item.updatedAt)}` : ''}`
        ));
      }
      complementary.appendChild(wrapper);
    }
    if (!complementaryInputs.length) {
      complementary.appendChild(element('div', 'im-meta', 'Aún no hay campos complementarios definidos para esta vacante.'));
    }
    card.appendChild(complementary);

    const addRow = element('div', 'im-inline-add');
    const newLabelInput = document.createElement('input');
    newLabelInput.type = 'text';
    newLabelInput.className = 'im-input';
    newLabelInput.maxLength = 80;
    newLabelInput.placeholder = 'Nombre del nuevo campo complementario';
    const addButton = element('button', 'im-plus', '+');
    addButton.type = 'button';
    addButton.title = 'Agregar campo complementario';
    addButton.setAttribute('aria-label', 'Agregar campo complementario');
    addRow.append(newLabelInput, addButton);
    card.appendChild(addRow);

    addButton.addEventListener('click', async () => {
      const label = newLabelInput.value.trim();
      if (!label) {
        setStatus(status, 'Escribe el nombre del campo complementario.', 'error');
        newLabelInput.focus();
        return;
      }
      addButton.disabled = true;
      setStatus(status, 'Agregando campo...');
      try {
        await api(`/candidates/${encodeURIComponent(candidateId)}/complementary-fields`, {
          method: 'POST',
          body: JSON.stringify({ label })
        });
        const refreshed = await api(`/candidates/${encodeURIComponent(candidateId)}`);
        renderDetailCard(candidateId, refreshed);
      } catch (error) {
        setStatus(status, 'No fue posible agregar el campo.', 'error');
        addButton.disabled = false;
      }
    });

    const actions = element('div', 'im-actions');
    const saveButton = element('button', 'im-btn', 'Guardar evaluación');
    saveButton.type = 'button';
    actions.append(saveButton, status);
    card.appendChild(actions);

    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      setStatus(status, 'Guardando evaluación...');
      try {
        const payload = {
          rating: ratingInput.value === '' ? null : ratingInput.value,
          observationEnabled: observationCheckbox.checked,
          observation: observationCheckbox.checked ? observationArea.value : '',
          values: complementaryInputs.map(({ fieldId, input }) => ({
            fieldId,
            value: input.value
          }))
        };
        await api(`/candidates/${encodeURIComponent(candidateId)}/evaluation`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const refreshed = await api(`/candidates/${encodeURIComponent(candidateId)}`);
        renderDetailCard(candidateId, refreshed);
      } catch (error) {
        const message = error.message === 'interview_rating_out_of_range'
          ? 'La calificación debe estar entre 1 y 5.'
          : error.message === 'interview_observation_required_when_enabled'
            ? 'Escribe la observación o desmarca la opción.'
            : 'No fue posible guardar la evaluación.';
        setStatus(status, message, 'error');
        saveButton.disabled = false;
      }
    });

    const interviewCard = findInterviewCard();
    if (interviewCard?.parentNode) interviewCard.parentNode.insertBefore(card, interviewCard);
    else document.querySelector('.container')?.appendChild(card);
  }

  async function enhanceCandidateDetail() {
    const candidateId = detailCandidateId();
    if (!candidateId) return;
    try {
      const response = await api(`/candidates/${encodeURIComponent(candidateId)}`);
      renderDetailCard(candidateId, response);
    } catch (error) {
      if (error.status !== 404) console.error('[INTERVIEW_MANAGEMENT_DETAIL_ERROR]', error);
    }
  }

  async function boot() {
    addStyles();
    await Promise.all([
      enhanceDashboardSections(),
      enhanceCandidateDetail()
    ]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
