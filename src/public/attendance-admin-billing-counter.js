'use strict';

(() => {
  const ENDPOINT = '/admin/operaciones/asistencia/billing-counter';
  const START_DATE_ENDPOINT = '/admin/operaciones/asistencia/billing-counter/start-date';
  const AUTO_REFRESH_MS = 60_000;

  function text(value, fallback = '') {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || fallback;
  }

  function statusLabel(status) {
    if (status === 'CLOSED') return 'Ciclo cerrado';
    if (status === 'UPCOMING') return 'Inicio pendiente';
    return 'Ciclo en curso';
  }

  function dateLabel(dateKey, fallback = 'Pendiente') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return fallback;
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return fallback;
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date).replace('.', '');
  }

  function documentLabel(worker) {
    const number = text(worker?.documentNumber);
    if (!number) return 'Documento no registrado';
    const type = text(worker?.documentType);
    return type ? `${type} ${number}` : number;
  }

  function serviceRange(worker) {
    const first = text(worker?.firstServiceDate);
    const last = text(worker?.lastServiceDate);
    if (!first) return 'Sin fecha operativa';
    return first === last ? first : `${first} → ${last}`;
  }

  function addStyles() {
    if (document.getElementById('attendance-billing-counter-styles')) return;
    const style = document.createElement('style');
    style.id = 'attendance-billing-counter-styles';
    style.textContent = `
      .attendance-billing-counter { background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow-sm); padding:16px; display:grid; gap:14px; }
      .attendance-billing-head { display:flex; gap:16px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; }
      .attendance-billing-eyebrow { color:var(--muted); font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; }
      .attendance-billing-value { margin-top:3px; color:var(--navy); font-size:34px; line-height:1; font-weight:950; }
      .attendance-billing-value span { margin-left:7px; color:var(--muted); font-size:13px; font-weight:800; }
      .attendance-billing-cycle { margin:7px 0 0; color:var(--muted); font-size:12px; }
      .attendance-billing-policy { display:grid; grid-template-columns:repeat(3,minmax(150px,1fr)); gap:8px; }
      .attendance-billing-policy-item { border:1px solid #e5eaf0; border-radius:12px; padding:9px 10px; background:#f8fafc; display:grid; gap:2px; }
      .attendance-billing-policy-item small { color:var(--muted); font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; }
      .attendance-billing-policy-item strong { color:var(--navy); font-size:12px; }
      .attendance-billing-note { margin:0; color:var(--muted); font-size:11px; line-height:1.45; }
      .attendance-billing-config { border:1px solid #bfdbfe; border-radius:13px; background:#eff6ff; padding:11px; display:grid; gap:8px; }
      .attendance-billing-config-title { color:#1e40af; font-size:11px; font-weight:950; }
      .attendance-billing-config-controls { display:flex; gap:8px; align-items:end; flex-wrap:wrap; }
      .attendance-billing-config-field { display:grid; gap:4px; min-width:190px; }
      .attendance-billing-config-field label { color:#1e3a8a; font-size:10px; font-weight:900; }
      .attendance-billing-config-field input { border:1px solid #93c5fd; border-radius:9px; padding:8px 9px; background:#fff; color:var(--navy); font:inherit; }
      .attendance-billing-config button { min-height:34px; border:1px solid #93c5fd; border-radius:9px; padding:7px 10px; background:#fff; color:#1e40af; font:inherit; font-size:11px; font-weight:900; cursor:pointer; }
      .attendance-billing-config button[data-primary] { background:#1d4ed8; border-color:#1d4ed8; color:#fff; }
      .attendance-billing-config button:disabled { opacity:.55; cursor:not-allowed; }
      .attendance-billing-config-feedback { min-height:16px; margin:0; color:#1e40af; font-size:10.5px; font-weight:800; }
      .attendance-billing-config-feedback.error { color:#991b1b; }
      .attendance-billing-tabs { display:flex; gap:7px; flex-wrap:wrap; }
      .attendance-billing-tabs button { border:1px solid var(--border); background:#fff; color:var(--navy); border-radius:999px; padding:7px 10px; font:inherit; font-size:11px; font-weight:900; cursor:pointer; }
      .attendance-billing-tabs button[aria-pressed="true"] { background:var(--navy); border-color:var(--navy); color:#fff; }
      .attendance-billing-details { border-top:1px solid var(--border); padding-top:11px; }
      .attendance-billing-details > summary { cursor:pointer; color:var(--navy); font-size:12px; font-weight:900; }
      .attendance-billing-list { display:grid; gap:7px; margin-top:10px; max-height:420px; overflow:auto; }
      .attendance-billing-worker { display:grid; grid-template-columns:minmax(180px,1.4fr) minmax(150px,1fr) minmax(155px,1fr) minmax(120px,.8fr); gap:8px 12px; align-items:center; padding:9px 10px; border:1px solid #e5eaf0; border-radius:12px; background:#f8fafc; }
      .attendance-billing-worker strong { display:block; color:var(--navy); font-size:12px; }
      .attendance-billing-worker small { display:block; margin-top:2px; color:var(--muted); font-size:10px; }
      .attendance-billing-reason { justify-self:start; display:inline-flex; border-radius:999px; padding:4px 7px; background:#e6f4f1; color:#0d6b5f; font-size:9px; font-weight:900; }
      .attendance-billing-duplicate { display:inline-block; margin-left:5px; color:#b45309; font-size:9px; font-weight:900; }
      .attendance-billing-empty, .attendance-billing-error { margin:0; color:var(--muted); font-size:12px; }
      .attendance-billing-error { color:#991b1b; }
      @media (max-width:760px) { .attendance-billing-worker,.attendance-billing-policy { grid-template-columns:1fr; } .attendance-billing-reason { justify-self:start; } .attendance-billing-config-controls { align-items:stretch; } .attendance-billing-config-field { width:100%; } }
    `;
    document.head.appendChild(style);
  }

  function workerNode(worker) {
    const row = document.createElement('div');
    row.className = 'attendance-billing-worker';

    const identity = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = text(worker?.fullName, 'Auxiliar sin nombre');
    identity.appendChild(name);
    const doc = document.createElement('small');
    doc.textContent = documentLabel(worker);
    identity.appendChild(doc);
    if (worker?.duplicateWorkerRecords === true) {
      const duplicate = document.createElement('span');
      duplicate.className = 'attendance-billing-duplicate';
      duplicate.textContent = 'Documento asociado a más de un registro';
      identity.appendChild(duplicate);
    }

    const dates = document.createElement('div');
    const datesTitle = document.createElement('strong');
    datesTitle.textContent = serviceRange(worker);
    dates.appendChild(datesTitle);
    const datesMeta = document.createElement('small');
    const days = Number(worker?.serviceDays || 0);
    datesMeta.textContent = `${days} día${days === 1 ? '' : 's'} con servicio`;
    dates.appendChild(datesMeta);

    const assignments = document.createElement('div');
    const assignmentsTitle = document.createElement('strong');
    const count = Number(worker?.assignments || 0);
    assignmentsTitle.textContent = `${count} asignación${count === 1 ? '' : 'es'}`;
    assignments.appendChild(assignmentsTitle);
    const assignmentsMeta = document.createElement('small');
    assignmentsMeta.textContent = 'Cuenta una sola vez en el ciclo';
    assignments.appendChild(assignmentsMeta);

    const reason = document.createElement('span');
    reason.className = 'attendance-billing-reason';
    reason.textContent = text(worker?.reasonLabel, 'Gestionado');

    row.append(identity, dates, assignments, reason);
    return row;
  }

  function renderCycle(section, cycle, settings) {
    const value = section.querySelector('[data-billing-value]');
    const cycleText = section.querySelector('[data-billing-cycle]');
    const payment = section.querySelector('[data-billing-payment]');
    const details = section.querySelector('[data-billing-details]');
    const summary = section.querySelector('[data-billing-summary]');
    const list = section.querySelector('[data-billing-list]');

    if (!cycle) {
      value.firstChild.textContent = '0';
      cycleText.textContent = settings?.billingStartDate
        ? 'Todavía no existe un ciclo anterior al inicio oficial.'
        : 'Inicio oficial pendiente. DEV debe fijar la fecha antes de comenzar a contar.';
      payment.textContent = 'Pendiente';
      summary.textContent = 'Ver auxiliares incluidos (0)';
      list.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'attendance-billing-empty';
      empty.textContent = settings?.billingStartDate
        ? 'No hay auxiliares para mostrar en este período.'
        : 'Las pruebas previas al inicio oficial no se incluyen en el contador.';
      list.appendChild(empty);
      details.open = false;
      return;
    }

    value.firstChild.textContent = String(Number(cycle.count || 0));
    cycleText.textContent = `${statusLabel(cycle.status)} · ${text(cycle.label)}`;
    payment.textContent = dateLabel(cycle.paymentDate);
    const workers = Array.isArray(cycle.workers) ? cycle.workers : [];
    summary.textContent = `Ver auxiliares incluidos (${workers.length})`;
    list.replaceChildren();
    if (!workers.length) {
      const empty = document.createElement('p');
      empty.className = 'attendance-billing-empty';
      empty.textContent = cycle.status === 'UPCOMING'
        ? `El contador comenzará el ${dateLabel(cycle.start)}.`
        : 'Todavía no hay auxiliares que cumplan la regla del contador en este ciclo.';
      list.appendChild(empty);
    } else {
      workers.forEach((worker) => list.appendChild(workerNode(worker)));
    }
  }

  function buildDevEditor(payload) {
    if (payload?.canConfigure !== true) return null;
    const editor = document.createElement('div');
    editor.className = 'attendance-billing-config';
    editor.innerHTML = `
      <div class="attendance-billing-config-title">Configuración DEV · inicio oficial</div>
      <div class="attendance-billing-config-controls">
        <div class="attendance-billing-config-field">
          <label for="attendanceBillingStartDate">Fecha desde la que comienza a contar Asistencia</label>
          <input id="attendanceBillingStartDate" type="date" data-billing-start-input />
        </div>
        <button type="button" data-billing-use-today>Usar hoy</button>
        <button type="button" data-primary data-billing-save-start>Guardar fecha oficial</button>
      </div>
      <p class="attendance-billing-note">Cambiar esta fecha no borra marcaciones ni reinicia historial; únicamente redefine desde cuándo entra información al contador. Después, los ciclos cambian solos cada día 8.</p>
      <p class="attendance-billing-config-feedback" data-billing-config-feedback aria-live="polite"></p>
    `;
    const input = editor.querySelector('[data-billing-start-input]');
    const useToday = editor.querySelector('[data-billing-use-today]');
    const save = editor.querySelector('[data-billing-save-start]');
    const feedback = editor.querySelector('[data-billing-config-feedback]');
    input.value = text(payload?.settings?.billingStartDate);
    useToday.addEventListener('click', () => {
      input.value = text(payload?.settings?.today);
      input.focus();
    });
    save.addEventListener('click', async () => {
      const startDate = text(input.value);
      feedback.classList.remove('error');
      if (!startDate) {
        feedback.textContent = 'Selecciona una fecha de inicio.';
        feedback.classList.add('error');
        return;
      }
      save.disabled = true;
      useToday.disabled = true;
      feedback.textContent = 'Guardando…';
      try {
        const body = new URLSearchParams({ billingStartDate: startDate });
        const response = await fetch(START_DATE_ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Requested-With': 'attendance-admin'
          },
          body
        });
        const nextPayload = await response.json().catch(() => ({}));
        if (!response.ok || nextPayload.ok !== true) {
          throw new Error(text(nextPayload.error, 'No fue posible guardar la fecha oficial.'));
        }
        feedback.textContent = nextPayload.changed === false
          ? 'La fecha oficial ya estaba guardada.'
          : 'Fecha oficial guardada.';
        window.setTimeout(() => replaceCounter(nextPayload), 350);
      } catch (error) {
        feedback.textContent = text(error?.message, 'No fue posible guardar la fecha oficial.');
        feedback.classList.add('error');
      } finally {
        save.disabled = false;
        useToday.disabled = false;
      }
    });
    return editor;
  }

  function buildCounter(payload) {
    const settings = payload?.settings || {};
    const section = document.createElement('section');
    section.className = 'attendance-billing-counter';
    section.setAttribute('data-attendance-billing-counter', 'true');
    section.innerHTML = `
      <div class="attendance-billing-head">
        <div>
          <div class="attendance-billing-eyebrow">Contador del ciclo 8 → 7</div>
          <div class="attendance-billing-value" data-billing-value>0<span>auxiliares facturables</span></div>
          <p class="attendance-billing-cycle" data-billing-cycle></p>
        </div>
        <div class="attendance-billing-tabs" data-billing-tabs></div>
      </div>
      <div class="attendance-billing-policy" aria-label="Reglas del ciclo facturable">
        <div class="attendance-billing-policy-item"><small>Inicio oficial</small><strong data-billing-start>${dateLabel(settings.billingStartDate, 'Pendiente')}</strong></div>
        <div class="attendance-billing-policy-item"><small>Corte mensual</small><strong>Día 8 · ciclo 8 → 7</strong></div>
        <div class="attendance-billing-policy-item"><small>Pago de este ciclo</small><strong data-billing-payment>Pendiente</strong></div>
      </div>
      <p class="attendance-billing-note">El día 8 el contador pasa automáticamente al nuevo ciclo. No se borran asistencias ni se reinicia el historial; solo cambia el período que se consulta.</p>
      <details class="attendance-billing-details" data-billing-details>
        <summary data-billing-summary>Ver auxiliares incluidos (0)</summary>
        <div class="attendance-billing-list" data-billing-list></div>
      </details>
    `;

    const editor = buildDevEditor(payload);
    if (editor) section.querySelector('.attendance-billing-policy').insertAdjacentElement('afterend', editor);

    const tabs = section.querySelector('[data-billing-tabs]');
    const options = [
      ['current', 'Ciclo en curso', payload.current],
      ['previous', 'Ciclo anterior', payload.previous]
    ].filter(([, , cycle], index) => index === 0 || Boolean(cycle));

    options.forEach(([key, label, cycle], index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.billingCycle = key;
      button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
      button.addEventListener('click', () => {
        tabs.querySelectorAll('button').forEach((candidate) => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
        renderCycle(section, cycle, settings);
      });
      tabs.appendChild(button);
    });

    renderCycle(section, payload.current, settings);
    return section;
  }

  async function loadPayload() {
    const response = await fetch(ENDPOINT, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Requested-With': 'attendance-admin' }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error('attendance_billing_counter_unavailable');
    return payload;
  }

  function replaceCounter(payload) {
    const current = document.querySelector('[data-attendance-billing-counter]');
    if (!current) return;
    current.replaceWith(buildCounter(payload));
  }

  async function refreshCounter() {
    const current = document.querySelector('[data-attendance-billing-counter]');
    if (!current || current.contains(document.activeElement)) return;
    try {
      replaceCounter(await loadPayload());
    } catch {
      // El último estado válido se conserva si una actualización periódica falla.
    }
  }

  async function init() {
    if (!window.location.pathname.endsWith('/admin/operaciones/asistencia')) return;
    if (document.querySelector('[data-attendance-billing-counter]')) return;
    const anchor = document.querySelector('.filter-card') || document.querySelector('.hero');
    if (!anchor) return;
    addStyles();
    try {
      anchor.insertAdjacentElement('afterend', buildCounter(await loadPayload()));
      window.setInterval(refreshCounter, AUTO_REFRESH_MS);
    } catch {
      const section = document.createElement('section');
      section.className = 'attendance-billing-counter';
      section.setAttribute('data-attendance-billing-counter', 'true');
      const error = document.createElement('p');
      error.className = 'attendance-billing-error';
      error.textContent = 'No fue posible cargar el contador de auxiliares del ciclo.';
      section.appendChild(error);
      anchor.insertAdjacentElement('afterend', section);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
