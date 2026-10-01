'use strict';

(() => {
  const panels = [...document.querySelectorAll('[data-crew-manual]')];
  if (!panels.length) return;
  if (window.LorrenAndroidPresence || /LorrenNative\/1/.test(navigator.userAgent || '')) {
    panels.forEach((panel) => { panel.hidden = true; });
    return;
  }

  const markPath = '/operaciones/portal/cuadrillas/marcacion-manual';
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'worker-portal' };
  const labels = {
    ARRIVAL: 'entrada',
    BREAK_START: 'inicio de almuerzo',
    BREAK_END: 'fin de almuerzo',
    DEPARTURE: 'salida'
  };

  function markKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `crew_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
  }

  function location() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Este navegador no ofrece ubicación.'));
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy
        }),
        () => reject(new Error('No se pudo obtener tu ubicación. Activa el permiso e intenta de nuevo.')),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    });
  }

  function availableMarks(input) {
    if (input.dataset.departure) return [];
    if (!input.dataset.arrival) return ['ARRIVAL'];
    if (!input.dataset.breakStart) return ['BREAK_START', 'DEPARTURE'];
    if (!input.dataset.breakEnd) return ['BREAK_END'];
    return ['DEPARTURE'];
  }

  function memberState(input) {
    if (input.dataset.departure) return 'Salida registrada';
    if (!input.dataset.arrival) return 'Pendiente de entrada';
    if (input.dataset.breakStart && !input.dataset.breakEnd) return 'En almuerzo';
    if (input.dataset.breakEnd) return 'Almuerzo terminado';
    return 'Entrada registrada';
  }

  for (const panel of panels) {
    panel.closest('[data-assignment-card]')?.querySelector('[data-crew-standard-actions]')?.setAttribute('hidden', '');
    const assignmentId = panel.dataset.crewManual;
    const status = panel.querySelector('[data-crew-status]');
    const selectAll = panel.querySelector('[data-crew-all]');
    const inputs = [...panel.querySelectorAll('[data-crew-member]')];
    const actions = panel.querySelector('[data-crew-actions]');
    const buttons = [...panel.querySelectorAll('[data-crew-action]')];
    let busy = false;

    for (const input of inputs) {
      input.disabled = Boolean(input.dataset.departure);
      input.closest('label')?.querySelector('[data-crew-member-state]')?.replaceChildren(memberState(input));
    }

    function selected() {
      return inputs.filter((input) => input.checked && !input.disabled);
    }

    function updateActions() {
      const chosen = selected();
      const allowed = chosen.length
        ? availableMarks(chosen[0]).filter((mark) => chosen.every((input) => availableMarks(input).includes(mark)))
        : [];
      for (const button of buttons) button.hidden = !allowed.includes(button.dataset.crewAction);
      if (actions) actions.hidden = allowed.length === 0;
      if (selectAll) {
        const enabled = inputs.filter((input) => !input.disabled);
        selectAll.checked = enabled.length > 0 && enabled.every((input) => input.checked);
      }
      status.textContent = !chosen.length
        ? 'Selecciona uno o varios auxiliares para ver su siguiente marcación.'
        : allowed.length ? `${chosen.length} seleccionados. Elige la marcación que corresponde.`
          : 'Los seleccionados están en etapas distintas. Elige auxiliares con la misma marcación pendiente.';
    }

    selectAll?.addEventListener('change', () => {
      for (const input of inputs) if (!input.disabled) input.checked = selectAll.checked;
      updateActions();
    });
    for (const input of inputs) input.addEventListener('change', updateActions);

    for (const button of buttons) button.addEventListener('click', async () => {
      if (busy) return;
      const chosen = selected();
      const markType = button.dataset.crewAction;
      if (!chosen.length || !chosen.every((input) => availableMarks(input).includes(markType))) {
        updateActions();
        return;
      }
      busy = true;
      buttons.forEach((item) => { item.disabled = true; });
      status.textContent = 'Validando ubicación…';
      try {
        const coordinates = await location();
        status.textContent = `Registrando ${labels[markType]}…`;
        const response = await fetch(markPath, {
          method: 'POST', credentials: 'include', cache: 'no-store', headers,
          body: JSON.stringify({
            assignmentId,
            selectedAssignmentIds: chosen.map((input) => input.value),
            markType,
            idempotencyKey: markKey(),
            ...coordinates
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) throw new Error(payload.message || 'No se pudo registrar la marcación.');
        const summary = payload.summary || {};
        status.textContent = `${summary.newlyRecordedCount || 0} registradas, ${summary.alreadyRecordedCount || 0} ya registradas, ${summary.failedCount || 0} pendientes.`;
        if (payload.auditRecorded === false) status.textContent += ' La trazabilidad adicional no se guardó; informa al coordinador.';
        if (!summary.failedCount) window.setTimeout(() => window.location.reload(), 1500);
        else status.textContent += ' Actualiza la página para revisar cada estado.';
      } catch (error) {
        status.textContent = error.message || 'No se pudo registrar la marcación.';
      } finally {
        busy = false;
        buttons.forEach((item) => { item.disabled = false; });
      }
    });

    if (inputs.length) updateActions();
  }
})();
