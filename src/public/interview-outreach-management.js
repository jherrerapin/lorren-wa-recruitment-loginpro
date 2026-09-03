(() => {
  'use strict';

  const API_BASE = '/admin/interview-management';
  const STATUS_OPTIONS = [
    ['PENDING', 'Pendiente de respuesta'],
    ['CONFIRMED', 'Confirmó entrevista'],
    ['DECLINED', 'No interesado']
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
      .ic-list{display:grid;gap:8px}.ic-row{display:grid;grid-template-columns:minmax(180px,1.25fr) minmax(190px,.9fr) minmax(220px,1.05fr) auto;gap:10px;align-items:center;padding:10px 12px;background:#fff;border:1px solid #dbe5ef;border-radius:10px}
      .ic-person{min-width:0}.ic-name{display:block;color:var(--navy,#243b53);font-weight:800;text-decoration:none;overflow-wrap:anywhere}.ic-meta{margin-top:3px;color:var(--text-muted,#64748b);font-size:11px;line-height:1.35}
      .ic-field{display:flex;flex-direction:column;gap:4px}.ic-field label{font-size:11px;font-weight:800;color:#526477}.ic-control{width:100%;min-height:36px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;padding:6px 8px;color:#1f2937;font:inherit;font-size:12px;box-sizing:border-box}
      .ic-save{min-height:36px;border:0;border-radius:7px;padding:7px 12px;background:#1d4f7a;color:#fff;font-weight:800;cursor:pointer}.ic-save:disabled{opacity:.6;cursor:default}
      .ic-feedback{grid-column:1/-1;min-height:14px;color:#64748b;font-size:11px;font-weight:700}.ic-feedback[data-kind="error"]{color:#b91c1c}.ic-feedback[data-kind="success"]{color:#15803d}
      .ic-empty{padding:8px 0;color:#64748b;font-size:12px}.ic-booking{font-weight:700;color:#28557a}
      @media(max-width:900px){.ic-row{grid-template-columns:1fr 1fr}.ic-save{width:100%}}
      @media(max-width:620px){.ic-row{grid-template-columns:1fr}.ic-board{padding-left:12px;padding-right:12px}}
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

  function statusSelect(value) {
    const select = element('select', 'ic-control');
    for (const [optionValue, label] of STATUS_OPTIONS) {
      const option = element('option', '', label);
      option.value = optionValue;
      option.selected = optionValue === value;
      select.appendChild(option);
    }
    return select;
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

  function friendlyError(error) {
    if (error?.message === 'interview_management_datetime_required') {
      return 'Selecciona el día y la hora acordados para confirmar la entrevista.';
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

  async function renderBoard(panel) {
    const vacancyId = String(panel.dataset.vacancyPanel || '').trim();
    if (!vacancyId) return;

    const current = panel.querySelector('[data-interview-coordination-board]');
    try {
      const response = await api(`/vacancies/${encodeURIComponent(vacancyId)}`);
      const entries = response.entries || [];
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
        element('h3', 'ic-title', 'Coordinación de entrevistas'),
        element('p', 'ic-subtitle', 'Personas contactadas desde Mensajes a aprobados. Si confirman, registra libremente el día y la hora acordados con cada persona.')
      );

      const counts = statusCounts(entries);
      const chips = element('div', 'ic-counts');
      chips.append(
        element('span', 'ic-chip', `${counts.PENDING} pendientes`),
        element('span', 'ic-chip', `${counts.CONFIRMED} confirmados`),
        element('span', 'ic-chip', `${counts.DECLINED} no interesados`)
      );
      head.append(titleGroup, chips);

      const list = element('div', 'ic-list');
      const refresh = () => renderBoard(panel);
      entries.forEach((entry) => list.appendChild(renderRow(entry, vacancyId, refresh)));
      board.append(head, list);

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
