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
  const DECISION_OPTIONS = [
    ['', 'Seleccionar decisión'],
    ['CONTRATADO', 'Contratado'],
    ['RECHAZADO', 'Rechazado']
  ];

  function addStyles() {
    if (document.getElementById('interview-coordination-styles')) return;
    const style = document.createElement('style');
    style.id = 'interview-coordination-styles';
    style.textContent = `
      .ic-board{margin:0;border-bottom:1px solid var(--border-soft,#dbe5ef);background:#f8fbff;padding:14px 18px 16px}
      .ic-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
      .ic-title{margin:0;color:var(--navy,#243b53);font-size:16px}.ic-subtitle{margin:4px 0 0;color:var(--text-muted,#64748b);font-size:12px;line-height:1.45}
      .ic-tabs{display:flex;gap:7px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin;padding:2px 0 9px;margin-bottom:8px;border-bottom:1px solid #dbe5ef}
      .ic-tab{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;min-height:36px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;padding:7px 11px;color:#526477;font:inherit;font-size:12px;font-weight:850;cursor:pointer;white-space:nowrap}
      .ic-tab:hover{border-color:#8aa7c1;background:#f2f7fc}.ic-tab[aria-selected="true"]{border-color:#1d4f7a;background:#1d4f7a;color:#fff;box-shadow:0 1px 2px rgba(15,23,42,.12)}
      .ic-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:21px;height:21px;border-radius:999px;padding:0 6px;background:#e8f1fb;color:#28557a;font-size:10px;font-weight:900;box-sizing:border-box}
      .ic-tab[aria-selected="true"] .ic-tab-count{background:rgba(255,255,255,.2);color:#fff}
      .ic-tabpanel[hidden]{display:none!important}.ic-group{margin-top:0}.ic-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.ic-group-title{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.045em;color:#526477}.ic-group-count{font-size:11px;font-weight:800;color:#64748b;background:#eef2f7;border-radius:999px;padding:2px 7px}
      .ic-list{display:grid;gap:8px}.ic-row{display:grid;grid-template-columns:minmax(180px,1.25fr) minmax(190px,.9fr) minmax(220px,1.05fr) auto;gap:10px;align-items:center;padding:10px 12px;background:#fff;border:1px solid #dbe5ef;border-radius:10px}
      .ic-person{min-width:0}.ic-name{display:block;color:var(--navy,#243b53);font-weight:800;text-decoration:none;overflow-wrap:anywhere}.ic-meta{margin-top:3px;color:var(--text-muted,#64748b);font-size:11px;line-height:1.35}
      .ic-field{display:flex;flex-direction:column;gap:4px}.ic-field[hidden]{display:none!important}.ic-field label{font-size:11px;font-weight:800;color:#526477}.ic-control{width:100%;min-height:36px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;padding:6px 8px;color:#1f2937;font:inherit;font-size:12px;box-sizing:border-box}.ic-textarea{min-height:76px;resize:vertical}
      .ic-save{min-height:36px;border:0;border-radius:7px;padding:7px 12px;background:#1d4f7a;color:#fff;font-weight:800;cursor:pointer}.ic-save:disabled{opacity:.6;cursor:default}.ic-save-secondary{background:#475569}
      .ic-feedback{grid-column:1/-1;min-height:14px;color:#64748b;font-size:11px;font-weight:700}.ic-feedback[data-kind="error"]{color:#b91c1c}.ic-feedback[data-kind="success"]{color:#15803d}
      .ic-empty{padding:8px 0;color:#64748b;font-size:12px}.ic-booking{font-weight:700;color:#28557a}
      .ic-manual-day-item{display:grid;gap:8px}.ic-day-panel{border:1px dashed #b8c8d9;border-radius:10px;background:#fff;padding:12px 14px 14px}.ic-day-title{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}.ic-day-title strong{color:#243b53;font-size:13px}.ic-day-grid{display:grid;grid-template-columns:minmax(170px,.7fr) minmax(180px,.7fr) minmax(240px,1.2fr);gap:12px;align-items:start}.ic-day-evaluation{display:grid;gap:9px}.ic-observation-toggle{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:#526477}.ic-observation-toggle input{width:auto}.ic-complementary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.ic-complementary-create{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:8px;align-items:end;margin-top:9px}.ic-complementary-create .ic-day-status{grid-column:1/-1}.ic-day-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}.ic-day-status{min-height:15px;font-size:11px;font-weight:700;color:#64748b}.ic-day-status[data-kind="error"]{color:#b91c1c}.ic-day-status[data-kind="success"]{color:#15803d}
      .ic-reviewed-legend{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}.ic-reviewed-legend-item{display:inline-flex;align-items:center;gap:6px;border:1px solid #dbe5ef;border-radius:999px;background:#fff;padding:6px 9px;font-size:11px;font-weight:850;color:#334155}.ic-reviewed-dot{width:10px;height:10px;border-radius:999px}.ic-reviewed-legend-item[data-band="OPTIONED"] .ic-reviewed-dot{background:#16a34a}.ic-reviewed-legend-item[data-band="RESERVE"] .ic-reviewed-dot{background:#d97706}.ic-reviewed-legend-item[data-band="DISQUALIFIED"] .ic-reviewed-dot{background:#dc2626}
      .ic-reviewed-list{display:grid;gap:9px}.ic-reviewed-card{border:1px solid #dbe5ef;border-left-width:5px;border-radius:10px;background:#fff;padding:12px 13px;display:grid;gap:10px}.ic-reviewed-card[data-band="OPTIONED"]{border-left-color:#16a34a;background:#f8fff9}.ic-reviewed-card[data-band="RESERVE"]{border-left-color:#d97706;background:#fffdf5}.ic-reviewed-card[data-band="DISQUALIFIED"]{border-left-color:#dc2626;background:#fffafa}.ic-reviewed-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.ic-reviewed-score{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.ic-reviewed-rating{font-size:19px;font-weight:950;color:#1f2937}.ic-reviewed-band,.ic-reviewed-decision{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900}.ic-reviewed-band[data-band="OPTIONED"]{background:#dcfce7;color:#166534}.ic-reviewed-band[data-band="RESERVE"]{background:#fef3c7;color:#92400e}.ic-reviewed-band[data-band="DISQUALIFIED"]{background:#fee2e2;color:#991b1b}.ic-reviewed-decision[data-status="CONTRATADO"]{background:#dcfce7;color:#166534}.ic-reviewed-decision[data-status="RECHAZADO"]{background:#fee2e2;color:#991b1b}.ic-reviewed-decision[data-status="PENDING"]{background:#e2e8f0;color:#475569}.ic-reviewed-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}.ic-reviewed-summary-item{border:1px solid #e2e8f0;border-radius:8px;background:rgba(255,255,255,.8);padding:8px 9px}.ic-reviewed-summary-label{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.035em;color:#64748b}.ic-reviewed-summary-value{margin-top:3px;font-size:12px;color:#334155;white-space:pre-wrap;overflow-wrap:anywhere}.ic-reviewed-actions{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}.ic-reviewed-actions .ic-field{min-width:190px;flex:1}.ic-reviewed-editor{display:grid;gap:8px}.ic-reviewed-feedback{min-height:15px;color:#64748b;font-size:11px;font-weight:700}.ic-reviewed-feedback[data-kind="error"]{color:#b91c1c}.ic-reviewed-feedback[data-kind="success"]{color:#15803d}
      @media(max-width:900px){.ic-row{grid-template-columns:1fr 1fr}.ic-save{width:100%}.ic-day-grid{grid-template-columns:1fr 1fr}}
      @media(max-width:620px){.ic-row{grid-template-columns:1fr}.ic-board{padding-left:12px;padding-right:12px}.ic-day-grid{grid-template-columns:1fr}.ic-complementary-create{grid-template-columns:1fr}.ic-tabs{margin-left:-2px;margin-right:-2px}.ic-tab{min-height:40px}.ic-reviewed-actions{align-items:stretch}.ic-reviewed-actions .ic-field{min-width:0}.ic-reviewed-actions .ic-save{width:100%}}
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

  function formatInterviewRating(value) {
    if (value === null || value === undefined || String(value).trim() === '') return '';
    const numeric = Number(String(value).trim().replace(',', '.'));
    if (!Number.isFinite(numeric)) return String(value).trim();
    return numeric.toFixed(2).replace('.', ',');
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

  function selectedDashboardDate() {
    return String(document.getElementById('datePicker')?.value || '').trim();
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

  function isManualBooking(entry) {
    return Boolean(entry?.booking?.scheduledAt) && entry?.booking?.slotId == null;
  }

  function splitCoordinationEntries(entries = [], selectedDay = '') {
    const result = { pending: [], selected: [], scheduled: [], declined: [] };
    for (const entry of entries) {
      const status = entry?.invitation?.status || 'PENDING';
      if (status === 'DECLINED') {
        result.declined.push(entry);
      } else if (status === 'CONFIRMED' && entry?.booking?.scheduledAt) {
        const bookingDay = bogotaDay(entry.booking.scheduledAt);
        if (selectedDay && bookingDay !== selectedDay) continue;
        if (selectedDay && isManualBooking(entry)) result.selected.push(entry);
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
      return 'La calificación debe estar entre 1,00 y 5,00. Puedes usar coma o punto decimal.';
    }
    if (error?.message === 'interview_observation_required_when_enabled') {
      return 'Escribe la observación o desmarca la opción.';
    }
    if (error?.message === 'interview_complementary_label_required') {
      return 'Escribe el nombre del campo complementario.';
    }
    if (error?.message === 'interview_complementary_label_too_long') {
      return 'El nombre del campo complementario es demasiado largo.';
    }
    if (error?.message === 'candidate_status_not_confirmed') {
      return 'El estado no cambió. Revisa si existe una gestión o envío pendiente antes de intentarlo de nuevo.';
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
    const management = statusSelect(entry.invitation?.status || 'PENDING');
    managementField.append(element('label', '', 'Gestión'), management);

    const dateField = element('div', 'ic-field');
    const dateInput = interviewDateInput(entry);
    dateField.append(element('label', '', 'Día y hora de entrevista'), dateInput);

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

  function configureTabPanel(group, vacancyId, tabKey, activeKey) {
    group.classList.add('ic-tabpanel');
    group.id = `ic-panel-${vacancyId}-${tabKey}`;
    group.dataset.interviewCoordinationPanel = tabKey;
    group.setAttribute('role', 'tabpanel');
    group.setAttribute('aria-labelledby', `ic-tab-${vacancyId}-${tabKey}`);
    group.hidden = tabKey !== activeKey;
    return group;
  }

  function appendCoordinationGroup(board, title, entries, vacancyId, refresh, emptyText, tabKey, activeKey) {
    const group = configureTabPanel(element('section', 'ic-group'), vacancyId, tabKey, activeKey);
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

  function buildDayManagementPanel(candidateId, response, refresh) {
    const management = response.management || {};
    const panel = element('div', 'ic-day-panel');

    const title = element('div', 'ic-day-title');
    title.append(
      element('strong', '', 'Gestión de entrevista'),
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
    ratingInput.type = 'text';
    ratingInput.inputMode = 'decimal';
    ratingInput.pattern = '[1-5](?:[.,][0-9]{1,2})?';
    ratingInput.maxLength = 4;
    ratingInput.autocomplete = 'off';
    ratingInput.placeholder = '1,00 a 5,00';
    ratingInput.value = formatInterviewRating(management.evaluation?.rating);
    ratingInput.addEventListener('blur', () => {
      const formatted = formatInterviewRating(ratingInput.value);
      if (formatted) ratingInput.value = formatted;
    });
    const ratingField = managementField('Calificación', ratingInput);
    const band = management.evaluation?.band?.label;
    ratingField.appendChild(element('div', 'ic-meta', band ? `Clasificación actual: ${band}` : 'Escala de 1 a 5. Usa coma o punto decimal.'));

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
    const syncObservationField = ({ clear = false } = {}) => {
      const enabled = observationCheckbox.checked;
      observationField.hidden = !enabled;
      observationArea.disabled = !enabled;
      if (!enabled && clear) observationArea.value = '';
    };
    observationCheckbox.addEventListener('change', () => syncObservationField({ clear: true }));
    syncObservationField();
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
      panel.appendChild(element('div', 'ic-empty', 'Todavía no hay campos complementarios definidos para entrevistas.'));
    }

    const complementaryCreate = element('div', 'ic-complementary-create');
    const complementaryLabelInput = element('input', 'ic-control');
    complementaryLabelInput.type = 'text';
    complementaryLabelInput.maxLength = 80;
    complementaryLabelInput.placeholder = 'Ej. Disponibilidad de viaje';
    const complementaryLabelField = managementField('Nuevo campo complementario', complementaryLabelInput);
    complementaryLabelField.appendChild(element('div', 'ic-meta', 'Al crearlo quedará disponible para todas las vacantes.'));
    const addComplementaryField = element('button', 'ic-save ic-save-secondary', 'Agregar campo');
    addComplementaryField.type = 'button';
    const complementaryStatus = element('div', 'ic-day-status');
    complementaryCreate.append(complementaryLabelField, addComplementaryField, complementaryStatus);
    panel.appendChild(complementaryCreate);

    const actions = element('div', 'ic-day-actions');
    const saveAttendance = element('button', 'ic-save ic-save-secondary', 'Guardar asistencia');
    saveAttendance.type = 'button';
    const saveEvaluation = element('button', 'ic-save', 'Guardar evaluación');
    saveEvaluation.type = 'button';
    const status = element('div', 'ic-day-status');
    actions.append(saveAttendance, saveEvaluation, status);
    panel.appendChild(actions);

    addComplementaryField.addEventListener('click', async () => {
      const label = String(complementaryLabelInput.value || '').trim();
      if (!label) {
        complementaryStatus.textContent = 'Escribe el nombre del campo complementario.';
        complementaryStatus.dataset.kind = 'error';
        complementaryLabelInput.focus();
        return;
      }

      addComplementaryField.disabled = true;
      complementaryLabelInput.disabled = true;
      complementaryStatus.textContent = 'Agregando campo...';
      delete complementaryStatus.dataset.kind;
      try {
        const result = await api(`/candidates/${encodeURIComponent(candidateId)}/complementary-fields`, {
          method: 'POST',
          body: JSON.stringify({ label })
        });
        complementaryStatus.textContent = result.created
          ? 'Campo agregado para todas las vacantes.'
          : 'Ese campo ya existía y se reutilizará.';
        complementaryStatus.dataset.kind = 'success';
        await refresh();
      } catch (error) {
        complementaryStatus.textContent = friendlyError(error);
        complementaryStatus.dataset.kind = 'error';
        addComplementaryField.disabled = false;
        complementaryLabelInput.disabled = false;
      }
    });

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
        await refresh();
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
        ratingInput.value = formatInterviewRating(result.management?.evaluation?.rating);
        ratingField.querySelector('.ic-meta').textContent = nextBand
          ? `Clasificación actual: ${nextBand}`
          : 'Escala de 1 a 5. Usa coma o punto decimal.';
        status.textContent = 'Evaluación actualizada.';
        status.dataset.kind = 'success';
        await refresh();
      } catch (error) {
        status.textContent = friendlyError(error);
        status.dataset.kind = 'error';
      } finally {
        saveEvaluation.disabled = false;
      }
    });

    return panel;
  }

  function reviewedDecision(entry) {
    const status = String(entry?.candidateStatus || '').toUpperCase();
    if (status === 'CONTRATADO') return { key: 'CONTRATADO', label: 'Contratado' };
    if (status === 'RECHAZADO') return { key: 'RECHAZADO', label: 'Rechazado' };
    return { key: 'PENDING', label: 'Pendiente de decisión' };
  }

  function appendReviewedLegend(group) {
    const legend = element('div', 'ic-reviewed-legend');
    const definitions = [
      ['OPTIONED', '3,60–5,00 · Opcionado a contratar'],
      ['RESERVE', '3,00–3,59 · Reserva'],
      ['DISQUALIFIED', '1,00–2,99 · Descalificado']
    ];
    for (const [key, label] of definitions) {
      const item = element('span', 'ic-reviewed-legend-item');
      item.dataset.band = key;
      item.append(element('span', 'ic-reviewed-dot'), document.createTextNode(label));
      legend.appendChild(item);
    }
    group.appendChild(legend);
  }

  function appendReviewedSummary(card, entry) {
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
    if (summary.childElementCount) card.appendChild(summary);
  }

  async function persistCandidateDecision(entry, vacancyId, nextStatus) {
    const returnTo = `${window.location.pathname}${window.location.search}#vacancy-${vacancyId}`;
    const response = await fetch(`/admin/candidates/${encodeURIComponent(entry.candidateId)}/status`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ status: nextStatus, returnTo })
    });
    if (!response.ok) throw new Error(`candidate_status_request_failed_${response.status}`);

    const refreshed = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
    const stored = (refreshed.interviewed || []).find((candidate) => candidate.candidateId === entry.candidateId);
    if (!stored || stored.candidateStatus !== nextStatus) throw new Error('candidate_status_not_confirmed');
  }

  function appendReviewedGroup(board, entries, vacancyId, refresh, activeKey) {
    const group = configureTabPanel(element('section', 'ic-group'), vacancyId, 'interviewed', activeKey);
    const head = element('div', 'ic-group-head');
    head.append(
      element('span', 'ic-group-title', 'Entrevistados'),
      element('span', 'ic-group-count', entries.length)
    );
    group.appendChild(head);
    appendReviewedLegend(group);

    if (!entries.length) {
      group.appendChild(element('div', 'ic-empty', 'Aún no hay candidatos con asistencia y calificación registradas.'));
      board.appendChild(group);
      return;
    }

    const list = element('div', 'ic-reviewed-list');
    for (const entry of entries) {
      const card = element('article', 'ic-reviewed-card');
      const bandKey = entry?.evaluation?.band?.key || 'DISQUALIFIED';
      card.dataset.band = bandKey;

      const cardHead = element('div', 'ic-reviewed-head');
      const person = element('div', 'ic-person');
      const link = element('a', 'ic-name', entry.fullName || 'Candidato sin nombre');
      link.href = `/admin/candidates/${encodeURIComponent(entry.candidateId)}?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}#vacancy-${vacancyId}`)}`;
      person.appendChild(link);
      if (entry.phone) person.appendChild(element('div', 'ic-meta', `WhatsApp: ${entry.phone}`));
      if (entry.evaluation?.updatedAt) person.appendChild(element('div', 'ic-meta', `Evaluación: ${formatDate(entry.evaluation.updatedAt)}`));

      const score = element('div', 'ic-reviewed-score');
      score.appendChild(element('span', 'ic-reviewed-rating', formatInterviewRating(entry.evaluation?.rating)));
      const band = element('span', 'ic-reviewed-band', entry?.evaluation?.band?.label || 'Sin clasificación');
      band.dataset.band = bandKey;
      score.appendChild(band);
      const currentDecision = reviewedDecision(entry);
      const decisionBadge = element('span', 'ic-reviewed-decision', currentDecision.label);
      decisionBadge.dataset.status = currentDecision.key;
      score.appendChild(decisionBadge);
      cardHead.append(person, score);
      card.appendChild(cardHead);
      appendReviewedSummary(card, entry);

      const actions = element('div', 'ic-reviewed-actions');
      const edit = element('button', 'ic-save ic-save-secondary', 'Editar entrevista');
      edit.type = 'button';
      const decisionSelect = selectFor(
        DECISION_OPTIONS,
        currentDecision.key === 'PENDING' ? '' : currentDecision.key
      );
      const decisionField = managementField('Decisión final', decisionSelect);
      const saveDecision = element('button', 'ic-save', 'Guardar decisión');
      saveDecision.type = 'button';
      const feedback = element('div', 'ic-reviewed-feedback');
      actions.append(edit, decisionField, saveDecision, feedback);
      card.appendChild(actions);

      edit.addEventListener('click', async () => {
        const currentEditor = card.querySelector('[data-interview-reviewed-editor]');
        if (currentEditor) {
          currentEditor.remove();
          return;
        }
        edit.disabled = true;
        feedback.textContent = 'Cargando entrevista...';
        delete feedback.dataset.kind;
        try {
          const response = await api(`/candidates/${encodeURIComponent(entry.candidateId)}`);
          const editor = element('div', 'ic-reviewed-editor');
          editor.dataset.interviewReviewedEditor = 'true';
          editor.appendChild(buildDayManagementPanel(entry.candidateId, response, refresh));
          card.appendChild(editor);
          feedback.textContent = '';
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
        saveDecision.disabled = true;
        decisionSelect.disabled = true;
        feedback.textContent = 'Guardando decisión...';
        delete feedback.dataset.kind;
        try {
          await persistCandidateDecision(entry, vacancyId, nextStatus);
          feedback.textContent = 'Decisión actualizada.';
          feedback.dataset.kind = 'success';
          await refresh();
        } catch (error) {
          feedback.textContent = friendlyError(error);
          feedback.dataset.kind = 'error';
          saveDecision.disabled = false;
          decisionSelect.disabled = false;
        }
      });

      list.appendChild(card);
    }
    group.appendChild(list);
    board.appendChild(group);
  }

  async function appendManualSelectedDateGroup(board, entries, vacancyId, refresh, activeKey) {
    if (!entries.length) return;

    const group = configureTabPanel(element('section', 'ic-group'), vacancyId, 'selected', activeKey);
    group.dataset.manualInterviewSelectedDate = 'true';
    const head = element('div', 'ic-group-head');
    head.append(
      element('span', 'ic-group-title', 'Entrevistas manuales — fecha seleccionada'),
      element('span', 'ic-group-count', entries.length)
    );
    group.appendChild(head);

    const list = element('div', 'ic-list');
    for (const entry of entries) {
      const item = element('div', 'ic-manual-day-item');
      item.appendChild(renderRow(entry, vacancyId, refresh));
      try {
        const response = await api(`/candidates/${encodeURIComponent(entry.candidateId)}`);
        item.appendChild(buildDayManagementPanel(entry.candidateId, response, refresh));
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

  function createTabButton(vacancyId, key, label, count, activeKey) {
    const button = element('button', 'ic-tab');
    button.type = 'button';
    button.id = `ic-tab-${vacancyId}-${key}`;
    button.dataset.interviewCoordinationTab = key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `ic-panel-${vacancyId}-${key}`);
    button.setAttribute('aria-selected', key === activeKey ? 'true' : 'false');
    button.append(element('span', '', label), element('span', 'ic-tab-count', count));
    return button;
  }

  function activateCoordinationTab(board, key, focus = false) {
    const tabs = [...board.querySelectorAll('[data-interview-coordination-tab]')];
    const target = tabs.find((tab) => tab.dataset.interviewCoordinationTab === key) || tabs[0];
    if (!target) return;
    const activeKey = target.dataset.interviewCoordinationTab;
    board.dataset.activeCoordinationTab = activeKey;

    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of board.querySelectorAll('[data-interview-coordination-panel]')) {
      panel.hidden = panel.dataset.interviewCoordinationPanel !== activeKey;
    }
    if (focus) target.focus();
  }

  function installTabNavigation(board, vacancyId, groups, interviewed, activeKey) {
    const tabs = element('div', 'ic-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Secciones de coordinación y gestión de entrevistas');

    const definitions = [
      ['pending', 'Por gestionar', groups.pending.length],
      ...(groups.selected.length ? [['selected', 'Del día', groups.selected.length]] : []),
      ['scheduled', 'Programadas', groups.scheduled.length],
      ['declined', 'No interesados', groups.declined.length],
      ['interviewed', 'Entrevistados', interviewed.length]
    ];

    for (const [key, label, count] of definitions) {
      const button = createTabButton(vacancyId, key, label, count, activeKey);
      button.addEventListener('click', () => activateCoordinationTab(board, key));
      tabs.appendChild(button);
    }

    tabs.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...tabs.querySelectorAll('[data-interview-coordination-tab]')];
      if (!buttons.length) return;
      const currentIndex = Math.max(0, buttons.indexOf(document.activeElement));
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = buttons.length - 1;
      event.preventDefault();
      activateCoordinationTab(board, buttons[nextIndex].dataset.interviewCoordinationTab, true);
    });

    board.appendChild(tabs);
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
    const previousActiveKey = current?.dataset.activeCoordinationTab || null;
    try {
      const response = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
      const entries = response.entries || [];
      const interviewed = response.interviewed || [];
      separateAutomaticInterviews(panel, [...entries, ...interviewed]);

      if (!entries.length && !interviewed.length) {
        current?.remove();
        return;
      }

      const board = current || element('section', 'ic-board');
      board.dataset.interviewCoordinationBoard = vacancyId;
      board.replaceChildren();

      const selectedDay = selectedDashboardDate();
      const groups = splitCoordinationEntries(entries, selectedDay);
      const availableKeys = ['pending', ...(groups.selected.length ? ['selected'] : []), 'scheduled', 'declined', 'interviewed'];
      const defaultActiveKey = entries.length ? 'pending' : 'interviewed';
      const activeKey = previousActiveKey && availableKeys.includes(previousActiveKey)
        ? previousActiveKey
        : defaultActiveKey;
      board.dataset.activeCoordinationTab = activeKey;

      const head = element('div', 'ic-head');
      const titleGroup = element('div');
      titleGroup.append(
        element('h3', 'ic-title', 'Gestión de entrevistas'),
        element('p', 'ic-subtitle', 'Coordina entrevistas y consulta el histórico evaluado sin mezclar invitación, asistencia, calificación y decisión laboral.')
      );
      head.appendChild(titleGroup);
      board.appendChild(head);

      installTabNavigation(board, vacancyId, groups, interviewed, activeKey);

      const refresh = () => renderBoard(panel);
      appendCoordinationGroup(
        board,
        'Pendientes de respuesta',
        groups.pending,
        vacancyId,
        refresh,
        'No hay contactos pendientes de gestionar.',
        'pending',
        activeKey
      );
      await appendManualSelectedDateGroup(board, groups.selected, vacancyId, refresh, activeKey);
      appendCoordinationGroup(
        board,
        'Entrevistas programadas para la fecha seleccionada',
        groups.scheduled,
        vacancyId,
        refresh,
        'No hay entrevistas automáticas programadas para la fecha seleccionada.',
        'scheduled',
        activeKey
      );
      appendCoordinationGroup(
        board,
        'No interesados',
        groups.declined,
        vacancyId,
        refresh,
        'No hay personas marcadas como no interesadas.',
        'declined',
        activeKey
      );
      appendReviewedGroup(board, interviewed, vacancyId, refresh, activeKey);
      activateCoordinationTab(board, activeKey);

      if (!current) {
        const header = panel.querySelector('.vacancy-header');
        if (header) header.insertAdjacentElement('afterend', board);
        else panel.prepend(board);
      }
    } catch (_error) {
      if (current) {
        current.replaceChildren(element('div', 'ic-empty', 'No fue posible cargar la gestión de entrevistas.'));
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