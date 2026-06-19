(() => {
  const DEFAULT_MESSAGE = 'Esta solicitud ya superó las 2 horas posteriores a la hora del servicio. Puedes verla a detalle, pero no editarla.';
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  function buildServiceStart(date, time) {
    if (!date) return null;
    const startTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(time || '')) ? String(time).padStart(5, '0') : '00:00';
    const start = new Date(`${date}T${startTime}:00-05:00`);
    return Number.isNaN(start.getTime()) ? null : start;
  }

  function parseServiceStartFromText(text) {
    const match = String(text || '').match(/(\d{4}-\d{2}-\d{2})\s*·\s*([0-2]?\d:[0-5]\d)?/);
    if (!match) return null;
    return buildServiceStart(match[1], match[2]);
  }

  function findContextStart(element) {
    const directStart = buildServiceStart(element?.dataset?.serviceDate, element?.dataset?.startTime);
    if (directStart) return directStart;
    const context = element?.closest?.('.request-card, tr, .card, .assigned-card');
    return parseServiceStartFromText(context?.textContent || '');
  }

  function isLocked(element) {
    if (element?.dataset?.expiredEdit === 'true') return true;
    const start = findContextStart(element);
    if (!start) return false;
    return Date.now() > start.getTime() + TWO_HOURS_MS;
  }

  function ensureModal() {
    let modal = document.getElementById('expiredServiceRequestModal');
    if (modal) return modal;

    const style = document.createElement('style');
    style.textContent = `
      .expired-service-modal{position:fixed;inset:0;background:rgba(15,23,42,.46);display:flex;align-items:center;justify-content:center;padding:18px;z-index:10000;opacity:0;pointer-events:none;transition:opacity .18s ease}.expired-service-modal.show{opacity:1;pointer-events:auto}.expired-service-card{width:min(430px,100%);background:#fff;border-radius:18px;border:1px solid #e5e7eb;box-shadow:0 24px 70px rgba(15,23,42,.28);overflow:hidden;transform:translateY(8px);transition:transform .18s ease}.expired-service-modal.show .expired-service-card{transform:translateY(0)}.expired-service-head{display:flex;gap:12px;align-items:flex-start;padding:18px 18px 10px}.expired-service-icon{width:42px;height:42px;border-radius:999px;background:#fffbeb;color:#92400e;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;flex:0 0 auto}.expired-service-title{margin:0;color:#172033;font-size:18px;line-height:1.25}.expired-service-text{margin:5px 0 0;color:#64748b;font-size:13px;line-height:1.45}.expired-service-actions{padding:14px 18px 18px;display:flex;justify-content:flex-end}.expired-service-actions button{border:1px solid #0d7a6b;background:#0d7a6b;color:#fff;border-radius:999px;padding:9px 18px;font-weight:900;cursor:pointer}.expired-service-actions button:hover{background:#0b665a}`;
    document.head.appendChild(style);

    modal = document.createElement('div');
    modal.id = 'expiredServiceRequestModal';
    modal.className = 'expired-service-modal';
    modal.innerHTML = `
      <div class="expired-service-card" role="dialog" aria-modal="true" aria-labelledby="expiredServiceRequestTitle">
        <div class="expired-service-head">
          <div class="expired-service-icon">!</div>
          <div>
            <h2 class="expired-service-title" id="expiredServiceRequestTitle">Solicitud solo para consulta</h2>
            <p class="expired-service-text" id="expiredServiceRequestText"></p>
          </div>
        </div>
        <div class="expired-service-actions"><button type="button" id="expiredServiceRequestAccept">Aceptar</button></div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.classList.remove('show');
    modal.querySelector('#expiredServiceRequestAccept')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    return modal;
  }

  function showModal(message = DEFAULT_MESSAGE) {
    const modal = ensureModal();
    const text = modal.querySelector('#expiredServiceRequestText');
    if (text) text.textContent = message;
    modal.classList.add('show');
    window.setTimeout(() => modal.querySelector('#expiredServiceRequestAccept')?.focus(), 30);
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href*="/asignaciones/solicitudes/"][href$="/editar"], [data-expired-edit-link="true"]');
    if (!link || !isLocked(link)) return;
    event.preventDefault();
    showModal(link.dataset.expiredMessage || DEFAULT_MESSAGE);
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('form[action*="/solicitudes/"][action$="/eliminar"], [data-expired-delete-form="true"]');
    if (!form || !isLocked(form)) return;
    event.preventDefault();
    showModal(form.dataset.expiredMessage || DEFAULT_MESSAGE);
  }, true);
})();
