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
      .ic-field{display:flex;flex-direction:column;gap:4px}.ic-field label{font-size:11px;font-weight:800;color:#526477}.ic-select{width:100%;min-height:36px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;padding:6px 8px;color:#1f2937;font:inherit;font-size:12px}
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
    const select = element('select', 'ic-select');
    for (const [optionValue, label] of STATUS_OPTIONS) {
      const option = element('option', '', label);
      option.value = optionValue;
      option.selected = optionValue === value;
      select.appendChild(option);
    }
    return select;
  }

  function slotValue(slot) {
    return `${slot.slotId || ''}::${slot.scheduledAt || ''}`;
  }

  function parseSlotValue(value) {
    const separator = String(value || '').indexOf('::');
    if (separator < 1) return null;
    const slotId = value.slice(0, separator);
    const scheduledAt = value.slice(separator + 2);
    if (!slotId || !scheduledAt) return null;
    return { slotId, scheduledAt };
  }

  function interviewSlotSelect(entry, availableSlots) {
    const select = element('select', 'ic-select');
    const placeholder = element('option', '', 'Selecciona día y hora');
    placeholder.value = '';
    select.appendChild(placeholder);

    const seen = new Set();
    const addSlot = (slot, prefix = '') => {
      if (!slot?.slotId || !slot?.scheduledAt) return;
      const value = slotValue(slot);
      if (seen.has(value)) return;
      seen.add(value);
      const option = element('option', '', `${prefix}${slot.label || formatDate(slot.scheduledAt)}`);
      option.value = value;
      select.appendChild(option);
    };

    if (entry.booking) addSlot(entry.booking, 'Actual · ');
    (availableSlots || []).forEach((slot) => addSlot(slot));

    if (entry.booking) select.value = slotValue(entry.booking);
    return select;
  }

  function statusCounts(entries) {
    return entries.reduce((counts, entry) => {
      const status = entry?.invitation?.status || 'PENDING';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, { PENDING: 0, CONFIRMED: 0, DECLINED: 0 });
  }

  function friendlyError(error) {
    if (error?.message === 'interview_management_slot_required') return 'Selecciona un día y hora para confirmar la entrevista.';
    if (error?.message === 'interview_management_slot_unavailable') return 'Ese horario ya no está disponible. Actualiza la vacante y selecciona otro.';
    return 'No fue posible guardar la gestión. Intenta nuevamente.';
  }

  function renderRow(entry, availableSlots, vacancyId, refresh) {
    const row = element('div', 'ic-row');
    row.dataset.interviewCoordinationCandidate = entry.candidateId;

    const person = element('div', 'ic-person');
    const link = element('a', 'ic-name', entry.fullName || 'Candidato sin nombre');
    link.href = `/admin/candidates/${encodeURIComponent(entry.candidateId)}?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}#vacancy-${vacancyId}`)}`;
    person.appendChild(link);
    if (entry.phone) person.appendChild(element('div', 'ic-meta', `WhatsApp: ${entry.phone}`));
    if (entry.contactedAt) person.appendChild(element('div', 'ic-meta', `Contactado: ${formatDate(entry.contactedAt)}`));
    if (entry.booking?.scheduledAt) person.appendChild(element('div', 'ic-meta ic-booking', `Entrevista: ${entry.booking.label || formatDate(entry.booking.scheduledAt)}`));

    const managementField = element('div', 'ic-field');
    const managementLabel = element('label', '', 'Gestión');
    const management = statusSelect(entry.invitation?.status || 'PENDING');
    managementField.append(managementLabel, management);

    const slotField = element('div', 'ic-field');
    const slotLabel = element('label', '', 'Día y hora de entrevista');
    const slots = interviewSlotSelect(entry, availableSlots);
    slotField.append(slotLabel, slots);

    const save = element('button', 'ic-save', 'Guardar');
    save.type = 'button';
    const feedback = element('div', 'ic-feedback');

    const syncSlotVisibility = () => {
      const confirmed = management.value === 'CONFIRMED';
      slotField.hidden = !confirmed;
      slots.required = confirmed;
    };
    management.addEventListener('change', syncSlotVisibility);
    syncSlotVisibility();

    save.addEventListener('click', async () => {
      const body = { status: management.value };
      if (management.value === 'CONFIRMED') {
        const selected = parseSlotValue(slots.value);
        if (!selected) {
          feedback.textContent = 'Selecciona un día y hora para confirmar la entrevista.';
          feedback.dataset.kind = 'error';
          return;
        }
        body.slotId = selected.slotId;
        body.scheduledAt = selected.scheduledAt;
      }

      save.disabled = true;
      management.disabled = true;
      slots.disabled = true;
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
        slots.disabled = false;
      }
    });

    row.append(person, managementField, slotField, save, feedback);
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
        element('p', 'ic-subtitle', 'Personas contactadas desde Mensajes a aprobados. Registra aquí la respuesta y, cuando confirme, el horario acordado.')
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
      entries.forEach((entry) => list.appendChild(renderRow(entry, response.availableSlots || [], vacancyId, refresh)));
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
