'use strict';

(() => {
  const panels = document.querySelectorAll('[data-crew-manual]');
  if (!panels.length) return;
  const contextsPath = '/operaciones/portal/cuadrillas/proximidad/contexto';
  const markPath = '/operaciones/portal/cuadrillas/marcacion-manual';
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'worker-portal' };

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

  for (const panel of panels) {
    const assignmentId = panel.dataset.crewManual;
    const status = panel.querySelector('[data-crew-status]');
    const controls = panel.querySelector('[data-crew-controls]');
    const members = panel.querySelector('[data-crew-members]');
    const selectAll = panel.querySelector('[data-crew-all]');
    const submit = panel.querySelector('[data-crew-submit]');
    const load = panel.querySelector('[data-crew-load]');
    const markType = panel.querySelector('[data-crew-mark-type]');
    let context = null;
    let busy = false;

    function eligible(member) {
      const attendance = member.attendance || {};
      if (markType.value === 'ARRIVAL') return !attendance.arrivalAt;
      if (markType.value === 'BREAK_START') return Boolean(attendance.arrivalAt) && !attendance.breakStartAt && !attendance.departureAt;
      if (markType.value === 'BREAK_END') return Boolean(attendance.breakStartAt) && !attendance.breakEndAt && !attendance.departureAt;
      return Boolean(attendance.arrivalAt) && !attendance.departureAt;
    }

    function selected() {
      return [...members.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    }

    function renderMembers() {
      members.replaceChildren();
      for (const member of context.members || []) {
        if (member.isLeader || !eligible(member)) continue;
        const label = document.createElement('label');
        label.style.display = 'block';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = member.assignmentId;
        const name = document.createTextNode(` ${member.displayName || 'Auxiliar'}`);
        label.append(checkbox, name);
        members.append(label);
      }
      controls.hidden = false;
      selectAll.checked = false;
      status.textContent = members.children.length
        ? 'El encargado también quedará incluido cuando corresponda a esta marcación.'
        : 'No hay auxiliares pendientes para esta marcación.';
    }

    load.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      load.disabled = true;
      status.textContent = 'Cargando cuadrilla…';
      try {
        const response = await fetch(contextsPath, {
          method: 'POST', credentials: 'include', cache: 'no-store', headers, body: '{}'
        });
        const payload = await response.json().catch(() => ({}));
        context = (payload.assignments || []).find((item) => item.assignmentId === assignmentId);
        if (!response.ok || !context?.crewAvailable || !context.isCrewLeader) {
          throw new Error('Esta cuadrilla ya no está disponible para marcar.');
        }
        renderMembers();
      } catch (error) {
        status.textContent = error.message || 'No se pudo cargar la cuadrilla.';
      } finally {
        busy = false;
        load.disabled = false;
      }
    });

    selectAll.addEventListener('change', () => {
      for (const checkbox of members.querySelectorAll('input[type="checkbox"]')) checkbox.checked = selectAll.checked;
    });
    markType.addEventListener('change', () => {
      if (context) renderMembers();
    });
    members.addEventListener('change', () => {
      const boxes = [...members.querySelectorAll('input[type="checkbox"]')];
      selectAll.checked = boxes.length > 0 && boxes.every((box) => box.checked);
    });

    submit.addEventListener('click', async () => {
      if (busy) return;
      const selectedAssignmentIds = selected();
      if (!selectedAssignmentIds.length) {
        status.textContent = 'Selecciona al menos un auxiliar.';
        return;
      }
      busy = true;
      submit.disabled = true;
      status.textContent = 'Validando ubicación…';
      try {
        const coordinates = await location();
        status.textContent = 'Registrando marcaciones…';
        const response = await fetch(markPath, {
          method: 'POST', credentials: 'include', cache: 'no-store', headers,
          body: JSON.stringify({
            assignmentId,
            selectedAssignmentIds,
            markType: markType.value,
            idempotencyKey: crypto.randomUUID(),
            ...coordinates
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.message || 'No se pudo registrar la marcación.');
        }
        const summary = payload.summary || {};
        status.textContent = `${summary.newlyRecordedCount || 0} registradas, ${summary.alreadyRecordedCount || 0} ya registradas, ${summary.failedCount || 0} pendientes. Actualiza la página para ver el estado.`;
        if (payload.auditRecorded === false) {
          status.textContent += ' La trazabilidad adicional no se guardó; informa al coordinador.';
        }
      } catch (error) {
        status.textContent = error.message || 'No se pudo registrar la marcación.';
      } finally {
        busy = false;
        submit.disabled = false;
      }
    });
  }
})();
