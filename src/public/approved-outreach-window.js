(() => {
  if (window.location.pathname !== '/admin/outreach/approved') return;

  const table = document.querySelector('table.candidate-table');
  if (!table) return;

  const rows = Array.from(table.tBodies?.[0]?.rows || []);
  const candidates = rows.map((row) => {
    const checkbox = row.querySelector('input[name="candidateIds"]');
    const nameCell = row.querySelector('td:nth-child(2)');
    const name = nameCell?.querySelector('.candidate-name');
    const candidateId = String(checkbox?.value || '').trim();
    return candidateId && nameCell && name ? { row, candidateId, nameCell, name } : null;
  }).filter(Boolean);

  if (!candidates.length) return;

  function buildStatus(state) {
    const status = document.createElement('div');
    status.dataset.approvedWindowStatus = state.candidateId;
    status.style.cssText = 'font-size:12px;font-weight:700;margin-top:4px;line-height:1.35;';
    status.style.color = state.windowOpen ? '#15803d' : '#b45309';
    status.textContent = state.windowOpen
      ? 'Ventana 24 h abierta · se enviará mensaje libre'
      : 'Ventana 24 h cerrada · se usará plantilla';
    return status;
  }

  function buildFreeTextControls(state) {
    const wrapper = document.createElement('div');
    wrapper.dataset.approvedFreeText = state.candidateId;
    wrapper.style.cssText = 'display:grid;gap:6px;margin-top:8px;max-width:360px;';

    const textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.maxLength = 4000;
    textarea.placeholder = 'Escribe un mensaje libre para este candidato';
    textarea.setAttribute('aria-label', 'Mensaje libre para candidato aprobado');
    textarea.style.cssText = 'width:100%;min-height:54px;resize:vertical;border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;font:inherit;font-size:12px;line-height:1.4;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Enviar mensaje libre';
    button.style.cssText = 'border:1px solid #0d7a6b;border-radius:7px;background:#0d7a6b;color:#fff;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;';

    const feedback = document.createElement('span');
    feedback.setAttribute('aria-live', 'polite');
    feedback.style.cssText = 'font-size:12px;color:#6b7280;';

    button.addEventListener('click', async () => {
      const bodyText = textarea.value;
      if (!bodyText.trim()) {
        feedback.textContent = 'Escribe el mensaje antes de enviarlo.';
        return;
      }

      button.disabled = true;
      textarea.disabled = true;
      feedback.textContent = 'Enviando...';

      try {
        const body = new URLSearchParams();
        body.set('customBody', bodyText);
        const response = await fetch(
          '/admin/outreach/approved/' + encodeURIComponent(state.candidateId) + '/free-text',
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: body.toString()
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.message || 'No fue posible enviar el mensaje.');
        }
        textarea.value = '';
        feedback.style.color = '#15803d';
        feedback.textContent = payload.message || 'Mensaje enviado correctamente.';
      } catch (error) {
        feedback.style.color = '#b91c1c';
        feedback.textContent = error?.message || 'No fue posible enviar el mensaje.';
      } finally {
        button.disabled = false;
        textarea.disabled = false;
      }
    });

    actions.append(button, feedback);
    wrapper.append(textarea, actions);
    return wrapper;
  }

  function installState(candidate, state) {
    if (candidate.nameCell.querySelector('[data-approved-window-status]')) return;
    const status = buildStatus(state);
    candidate.name.insertAdjacentElement('afterend', status);
    if (state.windowOpen) status.insertAdjacentElement('afterend', buildFreeTextControls(state));
  }

  async function loadStates() {
    const query = new URLSearchParams();
    query.set('candidateIds', candidates.map((candidate) => candidate.candidateId).join(','));
    try {
      const response = await fetch('/admin/outreach/approved/window-status?' + query.toString(), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('window_status_failed');
      const payload = await response.json();
      const stateById = new Map((payload.candidates || []).map((state) => [state.candidateId, state]));
      candidates.forEach((candidate) => {
        const state = stateById.get(candidate.candidateId);
        if (state) installState(candidate, state);
      });
    } catch (_error) {
      candidates.forEach((candidate) => {
        if (candidate.nameCell.querySelector('[data-approved-window-status]')) return;
        const status = document.createElement('div');
        status.dataset.approvedWindowStatus = candidate.candidateId;
        status.style.cssText = 'font-size:12px;color:#6b7280;margin-top:4px;';
        status.textContent = 'No fue posible consultar la ventana de 24 h.';
        candidate.name.insertAdjacentElement('afterend', status);
      });
    }
  }

  void loadStates();
})();
