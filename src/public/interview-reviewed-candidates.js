(() => {
  'use strict';

  const API_BASE = '/admin/interview-management';
  const REVIEWED_KEY = 'interviewed';
  const ATTENDANCE_OPTIONS = [
    ['PENDING', 'Pendiente'],
    ['ATTENDED', 'Asistió'],
    ['NO_SHOW', 'No asistió']
  ];
  const DECISION_OPTIONS = [
    ['CONTRATADO', 'Contratado'],
    ['RECHAZADO', 'Rechazado']
  ];
  const refreshTimers = new WeakMap();
  const refreshInFlight = new WeakSet();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function addStyles() {
    if (document.getElementById('interview-reviewed-candidates-styles')) return;
    const style = document.createElement('style');
    style.id = 'interview-reviewed-candidates-styles';
    style.textContent = `
      .ic-reviewed-panel{display:grid;gap:12px}.ic-reviewed-legend{display:flex;gap:8px;flex-wrap:wrap;padding:2px 0 4px}.ic-reviewed-legend-item{display:inline-flex;align-items:center;gap:6px;border:1px solid #dbe5ef;border-radius:999px;background:#fff;padding:6px 9px;font-size:11px;font-weight:850;color:#334155}.ic-reviewed-legend-dot{width:10px;height:10px;border-radius:999px;display:inline-block}.ic-reviewed-legend-item[data-band="OPTIONED"] .ic-reviewed-legend-dot{background:#16a34a}.ic-reviewed-legend-item[data-band="RESERVE"] .ic-reviewed-legend-dot{background:#d97706}.ic-reviewed-legend-item[data-band="DISQUALIFIED"] .ic-reviewed-legend-dot{background:#dc2626}
      .ic-reviewed-list{display:grid;gap:9px}.ic-reviewed-card{border:1px solid #dbe5ef;border-left-width:5px;border-radius:10px;background:#fff;padding:12px 13px;display:grid;gap:10px}.ic-reviewed-card[data-band="OPTIONED"]{border-left-color:#16a34a;background:#f8fff9}.ic-reviewed-card[data-band="RESERVE"]{border-left-color:#d97706;background:#fffdf5}.ic-reviewed-card[data-band="DISQUALIFIED"]{border-left-color:#dc2626;background:#fffafa}.ic-reviewed-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.ic-reviewed-person{min-width:0;flex:1}.ic-reviewed-name{font-weight:900;color:#243b53;text-decoration:none;overflow-wrap:anywhere}.ic-reviewed-meta{margin-top:3px;color:#64748b;font-size:11px;line-height:1.4}.ic-reviewed-score{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.ic-reviewed-rating{font-size:19px;font-weight:950;color:#1f2937}.ic-reviewed-band,.ic-reviewed-decision{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900}.ic-reviewed-band[data-band="OPTIONED"]{background:#dcfce7;color:#166534}.ic-reviewed-band[data-band="RESERVE"]{background:#fef3c7;color:#92400e}.ic-reviewed-band[data-band="DISQUALIFIED"]{background:#fee2e2;color:#991b1b}.ic-reviewed-decision[data-status="CONTRATADO"]{background:#dcfce7;color:#166534}.ic-reviewed-decision[data-status="RECHAZADO"]{background:#fee2e2;color:#991b1b}.ic-reviewed-decision[data-status="PENDING"]{background:#e2e8f0;color:#475569}
      .ic-reviewed-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}.ic-reviewed-summary-item{border:1px solid #e2e8f0;border-radius:8px;background:rgba(255,255,255,.78);padding:8px 9px}.ic-reviewed-summary-label{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.035em;color:#64748b}.ic-reviewed-summary-value{margin-top:3px;font-size:12px;color:#334155;white-space:pre-wrap;overflow-wrap:anywhere}.ic-reviewed-actions{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}.ic-reviewed-actions .ic-field{min-width:190px;flex:1}.ic-reviewed-button{min-height:36px;border:0;border-radius:7px;padding:7px 12px;background:#1d4f7a;color:#fff;font-weight:850;cursor:pointer}.ic-reviewed-button-secondary{background:#475569}.ic-reviewed-button:disabled{opacity:.6;cursor:default}.ic-reviewed-feedback{min-height:15px;color:#64748b;font-size:11px;font-weight:750}.ic-reviewed-feedback[data-kind="error"]{color:#b91c1c}.ic-reviewed-feedback[data-kind="success"]{color:#15803d}
      .ic-reviewed-editor{border-top:1px solid #dbe5ef;padding-top:11px;display:grid;gap:10px}.ic-reviewed-editor-grid{display:grid;grid-template-columns:minmax(160px,.65fr) minmax(170px,.65fr) minmax(240px,1.2fr);gap:10px;align-items:start}.ic-reviewed-editor-evaluation{display:grid;gap:8px}.ic-reviewed-toggle{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:#526477}.ic-reviewed-complementary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.ic-reviewed-editor-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ic-reviewed-empty{padding:10px 0;color:#64748b;font-size:12px}
      @media(max-width:820px){.ic-reviewed-editor-grid{grid-template-columns:1fr 1fr}.ic-reviewed-editor-evaluation{grid-column:1/-1}}@media(max-width:620px){.ic-reviewed-card-head,.ic-reviewed-actions,.ic-reviewed-editor-actions{flex-direction:column;align-items:stretch}.ic-reviewed-editor-grid{grid-template-columns:1fr}.ic-reviewed-editor-evaluation{grid-column:auto}.ic-reviewed-actions .ic-field{min-width:0}.ic-reviewed-button{width:100%}}
    `;
    document.head.appendChild(style);
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

  function bandKey(entry) {
    return entry?.evaluation?.band?.key || 'DISQUALIFIED';
  }

  function bandLabel(entry) {
    return entry?.evaluation?.band?.label || 'Sin clasificación';
  }

  function decision(entry) {
    const status = String(entry?.candidateStatus || '').toUpperCase();
    if (status === 'CONTRATADO') return { key: 'CONTRATADO', label: 'Contratado' };
    if (status === 'RECHAZADO') return { key: 'RECHAZADO', label: 'Rechazado' };
    return { key: 'PENDING', label: 'Pendiente de decisión' };
  }

  function field(label, control) {
    const wrapper = element('div', 'ic-field');
    wrapper.append(element('label', '', label), control);
    return wrapper;
  }

  function selectFor(options, value) {
    const select = element('select', 'ic-control');
    for (const [optionValue, label] of options) {
      const option = element('option', '', label);
      option.value = optionValue;
      option.selected = optionValue === value;
      select.appendChild(option);
    }
    return select;
  }

  function installLegend(panel) {
    const legend = element('div', 'ic-reviewed-legend');
    const definitions = [
      ['OPTIONED', '3.60–5.00 · Opcionado a contratar'],
      ['RESERVE', '3.00–3.59 · Reserva'],
      ['DISQUALIFIED', '1.00–2.99 · Descalificado']
    ];
    for (const [key, label] of definitions) {
      const item = element('span', 'ic-reviewed-legend-item');
      item.dataset.band = key;
      item.append(element('span', 'ic-reviewed-legend-dot'), document.createTextNode(label));
      legend.appendChild(item);
    }
    panel.appendChild(legend);
  }

  function createBoard(panel, vacancyId) {
    const board = element('section', 'ic-board');
    board.dataset.interviewCoordinationBoard = vacancyId;
    board.dataset.activeCoordinationTab = REVIEWED_KEY;

    const head = element('div', 'ic-head');
    const titleGroup = element('div');
    titleGroup.append(
      element('h3', 'ic-title', 'Gestión de entrevistas'),
      element('p', 'ic-subtitle', 'Consulta histórica de candidatos entrevistados y decisiones posteriores a la entrevista.')
    );
    head.appendChild(titleGroup);
    board.appendChild(head);

    const tabs = element('div', 'ic-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Secciones de gestión de entrevistas');
    board.appendChild(tabs);

    const header = panel.querySelector('.vacancy-header');
    if (header) header.insertAdjacentElement('afterend', board);
    else panel.prepend(board);
    return board;
  }

  function activateTab(board, key) {
    const tabs = [...board.querySelectorAll('[data-interview-coordination-tab]')];
    const target = tabs.find((tab) => tab.dataset.interviewCoordinationTab === key);
    if (!target) return;
    board.dataset.activeCoordinationTab = key;
    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of board.querySelectorAll('[data-interview-coordination-panel]')) {
      panel.hidden = panel.dataset.interviewCoordinationPanel !== key;
    }
  }

  function installReviewedTab(board, vacancyId, count) {
    let tabs = board.querySelector('.ic-tabs');
    if (!tabs) {
      tabs = element('div', 'ic-tabs');
      tabs.setAttribute('role', 'tablist');
      board.appendChild(tabs);
    }

    const previous = tabs.querySelector('[data-interview-reviewed-tab]');
    const button = previous || element('button', 'ic-tab');
    button.type = 'button';
    button.id = `ic-tab-${vacancyId}-${REVIEWED_KEY}`;
    button.dataset.interviewCoordinationTab = REVIEWED_KEY;
    button.dataset.interviewReviewedTab = 'true';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `ic-panel-${vacancyId}-${REVIEWED_KEY}`);
    button.replaceChildren(
      element('span', '', 'Entrevistados'),
      element('span', 'ic-tab-count', count)
    );
    if (!previous) tabs.appendChild(button);
    button.onclick = () => activateTab(board, REVIEWED_KEY);
    return button;
  }

  function buildSummary(entry) {
    const summary = element('div', 'ic-reviewed-summary');
    if (entry?.evaluation?.observation) {
      const item = element('div', 'ic-reviewed-summary-item');
      item.append(
        element('div', 'ic-reviewed-summary-label', 'Observación'),
        element('div', 'ic-reviewed-summary-value', entry.evaluation.observation)
      );
      summary.appendChild(item);
    }
    for (const complementary of entry?.complementary || []) {
      const item = element('div', 'ic-reviewed-summary-item');
      item.append(
        element('div', 'ic-reviewed-summary-label', complementary.label || 'Información complementaria'),
        element('div', 'ic-reviewed-summary-value', complementary.value || '—')
      );
      summary.appendChild(item);
    }
    return summary;
  }

  function friendlyError(error) {
    if (error?.message === 'interview_rating_out_of_range') return 'La calificación debe estar entre 1 y 5.';
    if (error?.message === 'interview_observation_required_when_enabled') return 'Escribe la observación o desmarca la opción.';
    return 'No fue posible guardar el cambio. Actualiza la vista e intenta nuevamente.';
  }

  async function saveCandidateDecision(entry, vacancyId, nextStatus, feedback, button) {
    button.disabled = true;
    feedback.textContent = 'Guardando decisión...';
    delete feedback.dataset.kind;
    try {
      const returnTo = `${window.location.pathname}${window.location.search}#vacancy-${vacancyId}`;
      const response = await fetch(`/admin/candidates/${encodeURIComponent(entry.candidateId)}/status`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ status: nextStatus, returnTo })
      });
      if (!response.ok) throw new Error(`candidate_status_request_failed_${response.status}`);

      const refreshed = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
      const stored = (refreshed.interviewed || []).find((item) => item.candidateId === entry.candidateId);
      if (!stored || stored.candidateStatus !== nextStatus) {
        throw new Error('candidate_status_not_confirmed');
      }
      feedback.textContent = 'Decisión actualizada.';
      feedback.dataset.kind = 'success';
      scheduleRefresh(entry._panel, 0);
    } catch (error) {
      feedback.textContent = friendlyError(error);
      feedback.dataset.kind = 'error';
      button.disabled = false;
    }
  }

  function buildEditor(entry, vacancyId, response, container) {
    const management = response.management || {};
    const editor = element('div', 'ic-reviewed-editor');

    const grid = element('div', 'ic-reviewed-editor-grid');
    const attendance = selectFor(ATTENDANCE_OPTIONS, management.attendance?.status || 'PENDING');
    grid.appendChild(field('Asistencia real', attendance));

    const ratingInput = element('input', 'ic-control');
    ratingInput.type = 'number';
    ratingInput.min = '1';
    ratingInput.max = '5';
    ratingInput.step = '0.01';
    ratingInput.inputMode = 'decimal';
    ratingInput.value = management.evaluation?.rating ?? '';
    grid.appendChild(field('Calificación', ratingInput));

    const evaluation = element('div', 'ic-reviewed-editor-evaluation');
    const observationToggle = element('label', 'ic-reviewed-toggle');
    const observationCheckbox = document.createElement('input');
    observationCheckbox.type = 'checkbox';
    observationCheckbox.checked = Boolean(management.evaluation?.observationEnabled);
    observationToggle.append(observationCheckbox, document.createTextNode(' Agregar observación'));
    evaluation.appendChild(observationToggle);

    const observationArea = element('textarea', 'ic-control ic-textarea');
    observationArea.value = management.evaluation?.observation || '';
    observationArea.placeholder = 'Observación de la entrevista';
    const observationField = field('Observación', observationArea);
    const syncObservation = ({ clear = false } = {}) => {
      observationField.hidden = !observationCheckbox.checked;
      observationArea.disabled = !observationCheckbox.checked;
      if (!observationCheckbox.checked && clear) observationArea.value = '';
    };
    observationCheckbox.addEventListener('change', () => syncObservation({ clear: true }));
    syncObservation();
    evaluation.appendChild(observationField);
    grid.appendChild(evaluation);
    editor.appendChild(grid);

    const complementaryInputs = [];
    const complementaryFields = management.complementaryFields || [];
    if (complementaryFields.length) {
      editor.appendChild(element('div', 'ic-group-title', 'Información complementaria'));
      const complementary = element('div', 'ic-reviewed-complementary');
      for (const item of complementaryFields) {
        const input = element('input', 'ic-control');
        input.type = 'text';
        input.value = item.value || '';
        complementaryInputs.push({ fieldId: item.id, input });
        complementary.appendChild(field(item.label, input));
      }
      editor.appendChild(complementary);
    }

    const actions = element('div', 'ic-reviewed-editor-actions');
    const saveAttendance = element('button', 'ic-reviewed-button ic-reviewed-button-secondary', 'Guardar asistencia');
    saveAttendance.type = 'button';
    const saveEvaluation = element('button', 'ic-reviewed-button', 'Guardar evaluación');
    saveEvaluation.type = 'button';
    const close = element('button', 'ic-reviewed-button ic-reviewed-button-secondary', 'Cerrar edición');
    close.type = 'button';
    const feedback = element('div', 'ic-reviewed-feedback');
    actions.append(saveAttendance, saveEvaluation, close, feedback);
    editor.appendChild(actions);

    close.addEventListener('click', () => editor.remove());

    saveAttendance.addEventListener('click', async () => {
      saveAttendance.disabled = true;
      attendance.disabled = true;
      feedback.textContent = 'Guardando asistencia...';
      delete feedback.dataset.kind;
      try {
        await api(`/candidates/${encodeURIComponent(entry.candidateId)}/attendance`, {
          method: 'POST',
          body: JSON.stringify({ status: attendance.value })
        });
        window.location.reload();
      } catch (error) {
        feedback.textContent = friendlyError(error);
        feedback.dataset.kind = 'error';
        saveAttendance.disabled = false;
        attendance.disabled = false;
      }
    });

    saveEvaluation.addEventListener('click', async () => {
      saveEvaluation.disabled = true;
      feedback.textContent = 'Guardando evaluación...';
      delete feedback.dataset.kind;
      try {
        await api(`/candidates/${encodeURIComponent(entry.candidateId)}/evaluation`, {
          method: 'POST',
          body: JSON.stringify({
            rating: ratingInput.value === '' ? null : ratingInput.value,
            observationEnabled: observationCheckbox.checked,
            observation: observationCheckbox.checked ? observationArea.value : '',
            values: complementaryInputs.map(({ fieldId, input }) => ({ fieldId, value: input.value }))
          })
        });
        const refreshed = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
        const stillInterviewed = (refreshed.interviewed || []).some((item) => item.candidateId === entry.candidateId);
        if (!stillInterviewed) {
          window.location.reload();
          return;
        }
        feedback.textContent = 'Evaluación actualizada.';
        feedback.dataset.kind = 'success';
        scheduleRefresh(entry._panel, 0);
      } catch (error) {
        feedback.textContent = friendlyError(error);
        feedback.dataset.kind = 'error';
        saveEvaluation.disabled = false;
      }
    });

    container.appendChild(editor);
  }

  function buildReviewedCard(entry, vacancyId, panel) {
    const card = element('article', 'ic-reviewed-card');
    const key = bandKey(entry);
    card.dataset.band = key;
    entry._panel = panel;

    const head = element('div', 'ic-reviewed-card-head');
    const person = element('div', 'ic-reviewed-person');
    const link = element('a', 'ic-reviewed-name', entry.fullName || 'Candidato sin nombre');
    link.href = `/admin/candidates/${encodeURIComponent(entry.candidateId)}?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}#vacancy-${vacancyId}`)}`;
    person.appendChild(link);
    if (entry.phone) person.appendChild(element('div', 'ic-reviewed-meta', `WhatsApp: ${entry.phone}`));
    if (entry.evaluation?.updatedAt) {
      person.appendChild(element('div', 'ic-reviewed-meta', `Evaluación: ${formatDate(entry.evaluation.updatedAt)}`));
    }

    const score = element('div', 'ic-reviewed-score');
    score.appendChild(element('span', 'ic-reviewed-rating', Number(entry.evaluation?.rating || 0).toFixed(2)));
    const band = element('span', 'ic-reviewed-band', bandLabel(entry));
    band.dataset.band = key;
    score.appendChild(band);
    const currentDecision = decision(entry);
    const decisionBadge = element('span', 'ic-reviewed-decision', currentDecision.label);
    decisionBadge.dataset.status = currentDecision.key;
    score.appendChild(decisionBadge);
    head.append(person, score);
    card.appendChild(head);

    const summary = buildSummary(entry);
    if (summary.childElementCount) card.appendChild(summary);

    const actions = element('div', 'ic-reviewed-actions');
    const edit = element('button', 'ic-reviewed-button ic-reviewed-button-secondary', 'Editar entrevista');
    edit.type = 'button';
    actions.appendChild(edit);

    const decisionSelect = selectFor(
      [['', 'Seleccionar decisión'], ...DECISION_OPTIONS],
      currentDecision.key === 'PENDING' ? '' : currentDecision.key
    );
    const decisionField = field('Decisión final', decisionSelect);
    actions.appendChild(decisionField);
    const saveDecision = element('button', 'ic-reviewed-button', 'Guardar decisión');
    saveDecision.type = 'button';
    const feedback = element('div', 'ic-reviewed-feedback');
    actions.append(saveDecision, feedback);
    card.appendChild(actions);

    edit.addEventListener('click', async () => {
      const existingEditor = card.querySelector('.ic-reviewed-editor');
      if (existingEditor) {
        existingEditor.remove();
        return;
      }
      edit.disabled = true;
      feedback.textContent = 'Cargando entrevista...';
      delete feedback.dataset.kind;
      try {
        const response = await api(`/candidates/${encodeURIComponent(entry.candidateId)}`);
        feedback.textContent = '';
        buildEditor(entry, vacancyId, response, card);
      } catch (error) {
        feedback.textContent = friendlyError(error);
        feedback.dataset.kind = 'error';
      } finally {
        edit.disabled = false;
      }
    });

    saveDecision.addEventListener('click', async () => {
      const nextStatus = decisionSelect.value;
      if (!nextStatus) {
        feedback.textContent = 'Selecciona Contratado o Rechazado.';
        feedback.dataset.kind = 'error';
        return;
      }
      await saveCandidateDecision(entry, vacancyId, nextStatus, feedback, saveDecision);
    });

    return card;
  }

  function renderReviewedPanel(board, panel, vacancyId, interviewed) {
    const old = board.querySelector('[data-interview-reviewed-panel]');
    const wasActive = board.dataset.activeCoordinationTab === REVIEWED_KEY;
    old?.remove();

    const reviewedPanel = element('section', 'ic-group ic-tabpanel ic-reviewed-panel');
    reviewedPanel.id = `ic-panel-${vacancyId}-${REVIEWED_KEY}`;
    reviewedPanel.dataset.interviewCoordinationPanel = REVIEWED_KEY;
    reviewedPanel.dataset.interviewReviewedPanel = 'true';
    reviewedPanel.setAttribute('role', 'tabpanel');
    reviewedPanel.setAttribute('aria-labelledby', `ic-tab-${vacancyId}-${REVIEWED_KEY}`);
    reviewedPanel.hidden = !wasActive;

    const head = element('div', 'ic-group-head');
    head.append(
      element('span', 'ic-group-title', 'Entrevistados'),
      element('span', 'ic-group-count', interviewed.length)
    );
    reviewedPanel.appendChild(head);
    installLegend(reviewedPanel);

    if (!interviewed.length) {
      reviewedPanel.appendChild(element('div', 'ic-reviewed-empty', 'Aún no hay candidatos con asistencia y calificación registradas.'));
    } else {
      const list = element('div', 'ic-reviewed-list');
      for (const entry of interviewed) list.appendChild(buildReviewedCard(entry, vacancyId, panel));
      reviewedPanel.appendChild(list);
    }

    board.appendChild(reviewedPanel);
    if (wasActive) activateTab(board, REVIEWED_KEY);
  }

  async function refreshReviewed(panel) {
    if (!panel || refreshInFlight.has(panel)) return;
    const vacancyId = String(panel.dataset.vacancyPanel || '').trim();
    if (!vacancyId) return;
    refreshInFlight.add(panel);
    try {
      const response = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
      const interviewed = response.interviewed || [];
      let board = panel.querySelector('[data-interview-coordination-board]');
      if (!board && !interviewed.length) return;
      if (!board) board = createBoard(panel, vacancyId);

      const hadReviewedTab = Boolean(board.querySelector('[data-interview-reviewed-tab]'));
      const wasActive = board.dataset.activeCoordinationTab === REVIEWED_KEY;
      installReviewedTab(board, vacancyId, interviewed.length);
      renderReviewedPanel(board, panel, vacancyId, interviewed);

      if (!hadReviewedTab && board.querySelectorAll('[data-interview-coordination-tab]').length === 1) {
        activateTab(board, REVIEWED_KEY);
      } else if (wasActive) {
        activateTab(board, REVIEWED_KEY);
      }
    } catch (_error) {
      const board = panel.querySelector('[data-interview-coordination-board]');
      const reviewedPanel = board?.querySelector('[data-interview-reviewed-panel]');
      if (reviewedPanel) {
        reviewedPanel.replaceChildren(element('div', 'ic-reviewed-empty', 'No fue posible cargar el histórico de entrevistados.'));
      }
    } finally {
      refreshInFlight.delete(panel);
    }
  }

  function scheduleRefresh(panel, delay = 40) {
    if (!panel) return;
    const previous = refreshTimers.get(panel);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      refreshTimers.delete(panel);
      refreshReviewed(panel);
    }, delay);
    refreshTimers.set(panel, timer);
  }

  function observePanel(panel) {
    const observer = new MutationObserver(() => {
      const board = panel.querySelector('[data-interview-coordination-board]');
      if (!board) {
        scheduleRefresh(panel);
        return;
      }
      if (!board.querySelector('[data-interview-reviewed-panel]') || !board.querySelector('[data-interview-reviewed-tab]')) {
        scheduleRefresh(panel);
      }
    });
    observer.observe(panel, { childList: true, subtree: true });
  }

  function start() {
    addStyles();
    for (const panel of document.querySelectorAll('[data-vacancy-panel]')) {
      observePanel(panel);
      scheduleRefresh(panel, 0);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();