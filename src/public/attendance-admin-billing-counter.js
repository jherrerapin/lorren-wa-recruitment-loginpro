'use strict';

(() => {
  const ENDPOINT = '/admin/operaciones/asistencia/billing-counter';

  function text(value, fallback = '') {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || fallback;
  }

  function statusLabel(status) {
    if (status === 'CLOSED') return 'Ciclo cerrado';
    if (status === 'UPCOMING') return 'Próximo ciclo';
    return 'Ciclo en curso';
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
      @media (max-width:760px) { .attendance-billing-worker { grid-template-columns:1fr; } .attendance-billing-reason { justify-self:start; } }
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

  function renderCycle(section, cycle) {
    const value = section.querySelector('[data-billing-value]');
    const cycleText = section.querySelector('[data-billing-cycle]');
    const details = section.querySelector('[data-billing-details]');
    const summary = section.querySelector('[data-billing-summary]');
    const list = section.querySelector('[data-billing-list]');

    if (!cycle) {
      value.firstChild.textContent = '0';
      cycleText.textContent = 'Todavía no existe un ciclo anterior al inicio del servicio.';
      summary.textContent = 'Ver auxiliares incluidos (0)';
      list.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'attendance-billing-empty';
      empty.textContent = 'No hay auxiliares para mostrar.';
      list.appendChild(empty);
      details.open = false;
      return;
    }

    value.firstChild.textContent = String(Number(cycle.count || 0));
    cycleText.textContent = `${statusLabel(cycle.status)} · ${text(cycle.label)}`;
    const workers = Array.isArray(cycle.workers) ? cycle.workers : [];
    summary.textContent = `Ver auxiliares incluidos (${workers.length})`;
    list.replaceChildren();
    if (!workers.length) {
      const empty = document.createElement('p');
      empty.className = 'attendance-billing-empty';
      empty.textContent = cycle.status === 'UPCOMING'
        ? 'El contador comenzará cuando inicie el ciclo.'
        : 'Todavía no hay auxiliares que cumplan la regla del contador en este ciclo.';
      list.appendChild(empty);
    } else {
      workers.forEach((worker) => list.appendChild(workerNode(worker)));
    }
  }

  function buildCounter(payload) {
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
      <details class="attendance-billing-details" data-billing-details>
        <summary data-billing-summary>Ver auxiliares incluidos (0)</summary>
        <div class="attendance-billing-list" data-billing-list></div>
      </details>
    `;

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
        renderCycle(section, cycle);
      });
      tabs.appendChild(button);
    });

    renderCycle(section, payload.current);
    return section;
  }

  async function init() {
    if (!window.location.pathname.endsWith('/admin/operaciones/asistencia')) return;
    if (document.querySelector('[data-attendance-billing-counter]')) return;
    const anchor = document.querySelector('.filter-card') || document.querySelector('.hero');
    if (!anchor) return;
    addStyles();
    try {
      const response = await fetch(ENDPOINT, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Requested-With': 'attendance-admin' }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error('attendance_billing_counter_unavailable');
      anchor.insertAdjacentElement('afterend', buildCounter(payload));
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
