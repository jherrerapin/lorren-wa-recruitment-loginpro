(() => {
  'use strict';

  const API_BASE = '/admin/interview-management';
  const STATUS_OPTIONS = [
    ['PENDING', 'Pendiente de respuesta'],
    ['CONFIRMED', 'Confirmó entrevista'],
    ['DECLINED', 'No interesado']
  ];
  const ATTENDANCE_OPTIONS = [
    ['PENDING', 'Pendiente'],
    ['ATTENDED', 'Asistió'],
    ['NO_SHOW', 'No asistió']
  ];

  function addStyles() {
    if (document.getElementById('interview-coordination-styles')) return;
    const style = document.createElement('style');
    style.id = 'interview-coordination-styles';
    style.textContent = `
      .ic-board{margin:0;border-bottom:1px solid var(--border-soft,#dbe5ef);background:#f8fbff;padding:14px 18px 16px}
      .ic-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
      .ic-title{margin:0;color:var(--navy,#243b53);font-size:16px}.ic-subtitle{margin:4px 0 0;color:var(--text-muted,#64748b);font-size:12px;line-height:1.45}
      .ic-counts{display:flex;gap:6px;flex-wrap:wrap}.ic-chip{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:800;background:#e8f1fb;color:#28557a}
      .ic-group{margin-top:12px}.ic-group:first-of-type{margin-top:0}.ic-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.ic-group-title{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.045em;color:#526477}.ic-group-count{font-size:11px;font-weight:800;color:#64748b;background:#eef2f7;border-radius:999px;padding:2px 7px}
      .ic-list{display:grid;gap:8px}.ic-row{display:grid;grid-template-columns:minmax(180px,1.25fr) minmax(190px,.9fr) minmax(220px,1.05fr) auto;gap:10px;align-items:center;padding:10px 12px;background:#fff;border:1px solid #dbe5ef;border-radius:10px}
      .ic-person{min-width:0}.ic-name{display:block;color:var(--navy,#243b53);font-weight:800;text-decoration:none;overflow-wrap:anywhere}.ic-meta{margin-top:3px;color:var(--text-muted,#64748b);font-size:11px;line-height:1.35}
      .ic-field{display:flex;flex-direction:column;gap:4px}.ic-field label{font-size:11px;font-weight:800;color:#526477}.ic-control{width:100%;min-height:36px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;padding:6px 8px;color:#1f2937;font:inherit;font-size:12px;box-sizing:border-box}.ic-textarea{min-height:76px;resize:vertical}
      .ic-save{min-height:36px;border:0;border-radius:7px;padding:7px 12px;background:#1d4f7a;color:#fff;font-weight:800;cursor:pointer}.ic-save:disabled{opacity:.6;cursor:default}.ic-save-secondary{background:#475569}
      .ic-feedback{grid-column:1/-1;min-height:14px;color:#64748b;font-size:11px;font-weight:700}.ic-feedback[data-kind="error"]{color:#b91c1c}.ic-feedback[data-kind="success"]{color:#15803d}
      .ic-empty{padding:8px 0;color:#64748b;font-size:12px}.ic-booking{font-weight:700;color:#28557a}
      .ic-manual-today-item{display:grid;gap:8px}.ic-day-panel{border:1px dashed #b8c8d9;border-radius:10px;background:#fff;padding:12px 14px 14px}.ic-day-title{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}.ic-day-title strong{color:#243b53;font-size:13px}.ic-day-grid{display:grid;grid-template-columns:minmax(170px,.7fr) minmax(180px,.7fr) minmax(240px,1.2fr);gap:12px;align-items:start}.ic-day-evaluation{display:grid;gap:9px}.ic-observation-toggle{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:#526477}.ic-observation-toggle input{width:auto}.ic-complementary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.ic-day-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}.ic-day-status{min-height:15px;font-size:11px;font-weight:700;color:#64748b}.ic-day-status[data-kind="error"]{color:#b91c1c}.ic-day-status[data-kind="success"]{color:#15803d}
      @media(max-width:900px){.ic-row{grid-template-columns:1fr 1fr}.ic-save{width:100%}.ic-day-grid{grid-template-columns:1fr 1fr}}
      @media(max-width:620px){.ic-row{grid-template-columns:1fr}.ic-board{padding-left:12px;padding-right:12px}.ic-day-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
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

  function bogotaDay(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  function bogotaToday() {
    return bogotaDay(new Date());
  }

  function selectedDashboardDate() {
    return String(document.getElementById('datePicker')?.value || '').trim();
  }

  function isTodayDashboard() {
    const selected = selectedDashboardDate();
    return Boolean(selected) && selected === bogotaToday();
  }

  function toBogotaDateTimeLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
  }

  function bogotaDateTimeToIso(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const date = new Date(`${normalized.length === 16 ? `${normalized}:00` : normalized}-05:00`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

  function statusSelect(value) {
    return selectFor(STATUS_OPTIONS, value);
  }

  function interviewDateInput(entry) {
    const input = element('input', 'ic-control');
    input.type = 'datetime-local';
    input.step = '60';
    input.value = toBogotaDateTimeLocal(entry?.booking?.scheduledAt);
    return input;
  }

  function statusCounts(entries) {
    return entries.reduce((counts, entry) => {
      const status = entry?.invitation?.status || 'PENDING';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, { PENDING: 0, CONFIRMED: 0, DECLINED: 0 });
  }

  function isManualBooking(entry) {
    return Boolean(entry?.booking?.scheduledAt) && entry?.booking?.slotId == null;
  }

  function splitCoordinationEntries(entries = [], includeToday = false) {
    const result = { pending: [], today: [], scheduled: [], declined: [] };
    for (const entry of entries) {
      const status = entry?.invitation?.status || 'PENDING';
      if (status === 'DECLINED') {
        result.declined.push(entry);
      } else if (status === 'CONFIRMED' && entry?.booking?.scheduledAt) {
        const belongsToToday = includeToday
          && isManualBooking(entry)
          && bogotaDay(entry.booking.scheduledAt) === bogotaToday();
        if (belongsToToday) result.today.push(entry);
        else result.scheduled.push(entry);
      } else {
        result.pending.push(entry);
      }
    }
    return result;
  }

  function friendlyError(error) {
    if (error?.message === 'interview_management_datetime_required') {
      return 'Selecciona el día y la hora acordados para confirmar la entrevista.';
    }
    if (error?.message === 'interview_rating_out_of_range') {
      return 'La calificación debe estar entre 1 y 5.';
    }
    if (error?.message === 'interview_observation_required_when_enabled') {
      return 'Escribe la observación o desmarca la opción.';
    }
    return 'No fue posible guardar la gestión. Intenta nuevamente.';
  }

  function renderRow(entry, vacancyId, refresh) {
    const row = element('div', 'ic-row');
    row.dataset.interviewCoordinationCandidate = entry.candidateId;

    const person = element('div', 'ic-person');
    const link = element('a', 'ic-name', entry.fullName || 'Candidato sin nombre');
    link.href = `/admin/candidates/${encodeURIComponent(entry.candidateId)}?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}#vacancy-${vacancyId}`)}`;
    person.appendChild(link);
    if (entry.phone) person.appendChild(element('div', 'ic-meta', `WhatsApp: ${entry.phone}`));
    if (entry.contactedAt) person.appendChild(element('div', 'ic-meta', `Contactado: ${formatDate(entry.contactedAt)}`));

    let bookingMeta = null;
    if (entry.booking?.scheduledAt) {
      bookingMeta = element('div', 'ic-meta ic-booking', `Entrevista: ${entry.booking.label || formatDate(entry.booking.scheduledAt)}`);
      person.appendChild(bookingMeta);
    }

    const managementField = element('div', 'ic-field');
    const managementLabel = element('label', '', 'Gestión');
    const management = statusSelect(entry.invitation?.status || 'PENDING');
    managementField.append(managementLabel, management);

    const dateField = element('div', 'ic-field');
    const dateLabel = element('label', '', 'Día y hora de entrevista');
    const dateInput = interviewDateInput(entry);
    dateField.append(dateLabel, dateInput);

    const save = element('button', 'ic-save', 'Guardar');
    save.type = 'button';
    const feedback = element('div', 'ic-feedback');

    const syncDateVisibility = () => {
      const confirmed = management.value === 'CONFIRMED';
      dateField.hidden = !confirmed;
      dateInput.required = confirmed;
      if (bookingMeta) bookingMeta.hidden = !confirmed;
    };
    management.addEventListener('change', syncDateVisibility);
    syncDateVisibility();

    save.addEventListener('click', async () => {
      const body = { status: management.value };
      if (management.value === 'CONFIRMED') {
        const scheduledAt = bogotaDateTimeToIso(dateInput.value);
        if (!scheduledAt) {
          feedback.textContent = 'Selecciona el día y la hora acordados para confirmar la entrevista.';
          feedback.dataset.kind = 'error';
          return;
        }
        body.scheduledAt = scheduledAt;
      }

      save.disabled = true;
      management.disabled = true;
      dateInput.disabled = true;
      feedback.textContent = 'Guardando...';
      delete feedback.dataset.kind;

      try {
        await api(`/candidates/${encodeURIComponent(entry.candidateId)}/coordination`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        feedback.textContent = 'Gestión actualizada.';
        feedback.dataset.kind = 'success';
        await refresh();
      } catch (error) {
        feedback.textContent = friendlyError(error);
        feedback.dataset.kind = 'error';
        save.disabled = false;
        management.disabled = false;
        dateInput.disabled = false;
      }
    });

    row.append(person, managementField, dateField, save, feedback);
    return row;
  }

  function appendCoordinationGroup(board, title, entries, vacancyId, refresh, emptyText) {
    const group = element('section', 'ic-group');
    const head = element('div', 'ic-group-head');
    head.append(
      element('span', 'ic-group-title', title),
      element('span', 'ic-group-count', entries.length)
    );
    group.appendChild(head);

    if (!entries.length) {
      group.appendChild(element('div', 'ic-empty', emptyText));
      board.appendChild(group);
      return;
    }

    const list = element('div', 'ic-list');
    entries.forEach((entry) => list.appendChild(renderRow(entry, vacancyId, refresh)));
    group.appendChild(list);
    board.appendChild(group);
  }

  function managementField(label, control) {
    const wrapper = element('div', 'ic-field');
    wrapper.append(element('label', '', label), control);
    return wrapper;
  }

  function buildDayManagementPanel(candidateId, response) {
    const management = response.management || {};
    const panel = element('div', 'ic-day-panel');

    const title = element('div', 'ic-day-title');
    title.append(
      element('strong', '', 'Gestión del día de entrevista'),
      element('span', 'ic-meta', 'Asistencia real, evaluación e información complementaria')
    );
    panel.appendChild(title);

    const grid = element('div', 'ic-day-grid');

    const attendance = selectFor(ATTENDANCE_OPTIONS, management.attendance?.status || 'PENDING');
    const attendanceField = managementField('Asistencia real', attendance);
    if (management.attendance?.updatedAt) {
      attendanceField.appendChild(element(
        'div',
        'ic-meta',
        `${management.attendance.updatedByLabel ? `Por ${management.attendance.updatedByLabel}` : 'Actualizado'} · ${formatDate(management.attendance.updatedAt)}`
      ));
    } else {
      attendanceField.appendChild(element('div', 'ic-meta', 'Registra aquí si asistió o no asistió.'));
    }

    const ratingInput = element('input', 'ic-control');
    ratingInput.type = 'number';
    ratingInput.min = '1';
    ratingInput.max = '5';
    ratingInput.step = '0.01';
    ratingInput.inputMode = 'decimal';
    ratingInput.placeholder = '1.00 a 5.00';
    ratingInput.value = management.evaluation?.rating ?? '';
    const ratingField = managementField('Calificación', ratingInput);
    const band = management.evaluation?.band?.label;
    ratingField.appendChild(element('div', 'ic-meta', band ? `Clasificación actual: ${band}` : 'Escala de 1 a 5.'));

    const evaluation = element('div', 'ic-day-evaluation');
    const observationToggle = element('label', 'ic-observation-toggle');
    const observationCheckbox = document.createElement('input');
    observationCheckbox.type = 'checkbox';
    observationCheckbox.checked = Boolean(management.evaluation?.observationEnabled);
    observationToggle.append(observationCheckbox, document.createTextNode(' Agregar observación'));

    const observationArea = element('textarea', 'ic-control ic-textarea');
    observationArea.placeholder = 'Observación de la entrevista';
    observationArea.value = management.evaluation?.observation || '';
    const observationField = managementField('Observación', observationArea);
    observationField.hidden = !observationCheckbox.checked;
    observationCheckbox.addEventListener('change', () => {
      observationField.hidden = !observationCheckbox.checked;
      if (!observationCheckbox.checked) observationArea.value = '';
    });
    evaluation.append(observationToggle, observationField);

    grid.append(attendanceField, ratingField, evaluation);
    panel.appendChild(grid);

    const complementaryFields = management.complementaryFields || [];
    const complementaryInputs = [];
    const complementaryTitle = element('div', 'ic-group-title', 'Información complementaria');
    complementaryTitle.style.marginTop = '12px';
    panel.appendChild(complementaryTitle);
    if (complementaryFields.length) {
      const complementary = element('div', 'ic-complementary');
      for (const item of complementaryFields) {
        const input = element('input', 'ic-control');
        input.type = 'text';
        input.value = item.value || '';
        input.placeholder = `Valor para ${item.label}`;
        complementaryInputs.push({ fieldId: item.id, input });
        complementary.appendChild(managementField(item.label, input));
      }
      panel.appendChild(complementary);
    } else {
      panel.appendChild(element('div', 'ic-empty', 'No hay campos complementarios definidos para esta vacante.'));
    }

    const actions = element('div', 'ic-day-actions');
    const saveAttendance = element('button', 'ic-save ic-save-secondary', 'Guardar asistencia');
    saveAttendance.type = 'button';
    const saveEvaluation = element('button', 'ic-save', 'Guardar evaluación');
    saveEvaluation.type = 'button';
    const status = element('div', 'ic-day-status');
    actions.append(saveAttendance, saveEvaluation, status);
    panel.appendChild(actions);

    saveAttendance.addEventListener('click', async () => {
      saveAttendance.disabled = true;
      attendance.disabled = true;
      status.textContent = 'Guardando asistencia...';
      delete status.dataset.kind;
      try {
        await api(`/candidates/${encodeURIComponent(candidateId)}/attendance`, {
          method: 'POST',
          body: JSON.stringify({ status: attendance.value })
        });
        status.textContent = 'Asistencia actualizada.';
        status.dataset.kind = 'success';
      } catch (error) {
        status.textContent = friendlyError(error);
        status.dataset.kind = 'error';
      } finally {
        saveAttendance.disabled = false;
        attendance.disabled = false;
      }
    });

    saveEvaluation.addEventListener('click', async () => {
      saveEvaluation.disabled = true;
      status.textContent = 'Guardando evaluación...';
      delete status.dataset.kind;
      const payload = {
        rating: ratingInput.value === '' ? null : ratingInput.value,
        observationEnabled: observationCheckbox.checked,
        observation: observationCheckbox.checked ? observationArea.value : '',
        values: complementaryInputs.map(({ fieldId, input }) => ({ fieldId, value: input.value }))
      };
      try {
        const result = await api(`/candidates/${encodeURIComponent(candidateId)}/evaluation`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const nextBand = result.management?.evaluation?.band?.label;
        ratingField.querySelector('.ic-meta').textContent = nextBand
          ? `Clasificación actual: ${nextBand}`
          : 'Escala de 1 a 5.';
        status.textContent = 'Evaluación actualizada.';
        status.dataset.kind = 'success';
      } catch (error) {
        status.textContent = friendlyError(error);
        status.dataset.kind = 'error';
      } finally {
        saveEvaluation.disabled = false;
      }
    });

    return panel;
  }

  async function appendManualTodayGroup(board, entries, vacancyId, refresh) {
    if (!entries.length) return;

    const group = element('section', 'ic-group');
    group.dataset.manualInterviewToday = 'true';
    const head = element('div', 'ic-group-head');
    head.append(
      element('span', 'ic-group-title', 'Entrevistas manuales — Hoy'),
      element('span', 'ic-group-count', entries.length)
    );
    group.appendChild(head);

    const list = element('div', 'ic-list');
    for (const entry of entries) {
      const item = element('div', 'ic-manual-today-item');
      item.appendChild(renderRow(entry, vacancyId, refresh));
      try {
        const response = await api(`/candidates/${encodeURIComponent(entry.candidateId)}`);
        item.appendChild(buildDayManagementPanel(entry.candidateId, response));
      } catch (error) {
        const message = error?.status === 404
          ? 'La gestión complementaria de esta entrevista no está disponible.'
          : 'No fue posible cargar la gestión del día de entrevista.';
        item.appendChild(element('div', 'ic-empty', message));
      }
      list.appendChild(item);
    }
    group.appendChild(list);
    board.appendChild(group);
  }

  function candidateIdFromBookingRow(row) {
    const link = row.querySelector('a.link-detail[href*="/admin/candidates/"]');
    if (!link) return null;
    const match = /\/admin\/candidates\/([^/?#]+)/.exec(link.getAttribute('href') || '');
    return match ? decodeURIComponent(match[1]) : null;
  }

  function findAutomaticInterviewSection(panel) {
    const titles = [...panel.querySelectorAll('.vacancy-body .section-title')];
    const title = titles.find((node) => /Entrevistas/i.test(node.textContent || ''));
    return title ? { title, section: title.closest('.section') } : null;
  }

  function separateAutomaticInterviews(panel, entries = []) {
    const found = findAutomaticInterviewSection(panel);
    if (!found?.section) return;

    if (!/Entrevistas automáticas/i.test(found.title.textContent || '')) {
      found.title.textContent = String(found.title.textContent || '').replace(/Entrevistas/i, 'Entrevistas automáticas');
    }

    const manualCandidateIds = new Set(entries
      .filter((entry) => isManualBooking(entry))
      .map((entry) => String(entry.candidateId || ''))
      .filter(Boolean));
    if (!manualCandidateIds.size) return;

    const table = found.section.querySelector('.bookings-table');
    if (!table) return;

    for (const row of [...table.querySelectorAll('tbody > tr')]) {
      const candidateId = candidateIdFromBookingRow(row);
      if (candidateId && manualCandidateIds.has(candidateId)) row.remove();
    }

    const remainingRows = table.querySelectorAll('tbody > tr').length;
    const count = found.section.querySelector('.section-count');
    if (count) count.textContent = `${remainingRows} cita${remainingRows === 1 ? '' : 's'}`;
    if (remainingRows === 0) found.section.hidden = true;
  }

  async function renderBoard(panel) {
    const vacancyId = String(panel.dataset.vacancyPanel || '').trim();
    if (!vacancyId) return;

    const current = panel.querySelector('[data-interview-coordination-board]');
    try {
      const response = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
      const entries = response.entries || [];
      separateAutomaticInterviews(panel, entries);

      if (!entries.length) {
        current?.remove();
        return;
      }

      const board = current || element('section', 'ic-board');
      board.dataset.interviewCoordinationBoard = vacancyId;
      board.replaceChildren();

      const head = element('div', 'ic-head');
      const titleGroup = element('div');
      titleGroup.append(
        element('h3', 'ic-title', 'Coordinación manual de entrevistas'),
        element('p', 'ic-subtitle', 'Este flujo es independiente de la agenda automática de Lórren. Gestiona respuestas, fecha acordada y el día de entrevista sin activar “Habilitar entrevistas” en la vacante.')
      );

      const counts = statusCounts(entries);
      const chips = element('div', 'ic-counts');
      chips.append(
        element('span', 'ic-chip', `${counts.PENDING} pendientes`),
        element('span', 'ic-chip', `${counts.CONFIRMED} programadas`),
        element('span', 'ic-chip', `${counts.DECLINED} no interesados`)
      );
      head.append(titleGroup, chips);
      board.appendChild(head);

      const groups = splitCoordinationEntries(entries, isTodayDashboard());
      const refresh = () => renderBoard(panel);
      appendCoordinationGroup(
        board,
        'Pendientes de respuesta',
        groups.pending,
        vacancyId,
        refresh,
        'No hay contactos pendientes de gestionar.'
      );
      await appendManualTodayGroup(board, groups.today, vacancyId, refresh);
      appendCoordinationGroup(
        board,
        'Entrevistas programadas',
        groups.scheduled,
        vacancyId,
        refresh,
        'Todavía no hay entrevistas con fecha y hora asignadas.'
      );
      appendCoordinationGroup(
        board,
        'No interesados',
        groups.declined,
        vacancyId,
        refresh,
        'No hay personas marcadas como no interesadas.'
      );

      if (!current) {
        const header = panel.querySelector('.vacancy-header');
        if (header) header.insertAdjacentElement('afterend', board);
        else panel.prepend(board);
      }
    } catch (_error) {
      if (current) {
        current.replaceChildren(element('div', 'ic-empty', 'No fue posible cargar la coordinación de entrevistas.'));
      }
    }
  }

  async function start() {
    addStyles();
    const panels = [...document.querySelectorAll('[data-vacancy-panel]')];
    for (const panel of panels) await renderBoard(panel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
