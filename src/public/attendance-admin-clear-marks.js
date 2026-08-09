'use strict';

(function installAttendanceClearMarks() {
  const MARKS = Object.freeze([
    { markType: 'ARRIVAL', label: 'entrada', datasetKey: 'arrivalMarkId' },
    { markType: 'BREAK_START', label: 'inicio de almuerzo', datasetKey: 'breakStartMarkId' },
    { markType: 'BREAK_END', label: 'fin de almuerzo', datasetKey: 'breakEndMarkId' },
    { markType: 'DEPARTURE', label: 'salida', datasetKey: 'departureMarkId' }
  ]);

  function hiddenInput(name, value) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    return input;
  }

  function appendFilters(form) {
    ['from', 'to', 'status', 'client', 'q'].forEach((name) => {
      const source = document.querySelector(`.filter-card [name="${name}"]`);
      if (source) form.appendChild(hiddenInput(name, source.value));
    });
  }

  function correctionForm(action, markType, reviewAction) {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = reviewAction;
    form.appendChild(hiddenInput('action', action));
    form.appendChild(hiddenInput('markType', markType));
    appendFilters(form);
    return form;
  }

  function sessionIdFromReviewAction(reviewAction) {
    try {
      const path = new URL(reviewAction, window.location.origin).pathname;
      const match = path.match(/\/sessions\/([^/]+)\/review$/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  function requestedCorrection() {
    const params = new URLSearchParams(window.location.search);
    const markType = String(params.get('correctionMarkType') || '').toUpperCase();
    const sessionId = String(params.get('correctionSessionId') || '');
    const mark = MARKS.find((item) => item.markType === markType) || null;
    return mark && sessionId ? { mark, sessionId } : null;
  }

  function deleteMarkForm(mark, markId, reviewAction) {
    const form = correctionForm('DELETE_MARK', mark.markType, reviewAction);
    form.dataset.attendanceDeleteMark = mark.markType;
    form.appendChild(hiddenInput('markId', markId));

    const button = document.createElement('button');
    button.className = 'btn btn-danger';
    button.type = 'submit';
    button.textContent = `Eliminar ${mark.label}`;
    form.appendChild(button);

    form.addEventListener('submit', (event) => {
      const confirmed = window.confirm(`¿Eliminar ${mark.label}? Las demás marcaciones de la jornada se conservarán.`);
      if (!confirmed) event.preventDefault();
    });
    return form;
  }

  function addMarkForm(mark, reviewAction) {
    const form = correctionForm('ADD_MARK', mark.markType, reviewAction);
    form.className = 'review-form';
    form.dataset.attendanceAddMark = mark.markType;

    const heading = document.createElement('h3');
    heading.textContent = `Corregir ${mark.label}`;
    form.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'review-hint';
    hint.textContent = `La marcación fue eliminada. Ingresa únicamente la nueva fecha y hora de ${mark.label}.`;
    form.appendChild(hint);

    const field = document.createElement('label');
    field.className = 'field';
    const label = document.createElement('span');
    label.textContent = 'Nueva fecha y hora';
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.name = 'reportedAt';
    input.required = true;
    field.appendChild(label);
    field.appendChild(input);
    form.appendChild(field);

    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.type = 'submit';
    button.textContent = `Guardar nueva ${mark.label}`;
    form.appendChild(button);
    return form;
  }

  function clearAllDetails(reviewAction) {
    const details = document.createElement('details');
    details.className = 'review-panel';
    details.dataset.attendanceClearForm = 'true';

    const summary = document.createElement('summary');
    summary.textContent = 'Corregir jornada completa';
    details.appendChild(summary);

    const form = document.createElement('form');
    form.className = 'review-form';
    form.method = 'post';
    form.action = reviewAction;
    form.appendChild(hiddenInput('action', 'CLEAR'));
    appendFilters(form);

    const explanation = document.createElement('p');
    explanation.className = 'review-hint';
    explanation.textContent = 'Usa esta opción únicamente si necesitas borrar entrada, almuerzo y salida para reconstruir toda la jornada.';
    form.appendChild(explanation);

    const button = document.createElement('button');
    button.className = 'btn btn-danger';
    button.type = 'submit';
    button.textContent = 'Eliminar todas las marcaciones';
    form.appendChild(button);

    form.addEventListener('submit', (event) => {
      const confirmed = window.confirm('¿Eliminar todas las marcaciones de esta jornada? La asignación y la auditoría se conservarán.');
      if (!confirmed) event.preventDefault();
    });

    details.appendChild(form);
    return details;
  }

  function install() {
    const correction = requestedCorrection();

    document.querySelectorAll('.review-content[data-attendance-review-action]').forEach((reviewContent) => {
      if (reviewContent.querySelector('[data-attendance-correction-controls="true"]')) return;
      const reviewAction = reviewContent.dataset.attendanceReviewAction;
      const sessionId = sessionIdFromReviewAction(reviewAction);
      if (!reviewAction || !sessionId) return;

      const markState = MARKS.map((mark) => ({
        ...mark,
        markId: reviewContent.dataset[mark.datasetKey] || ''
      }));
      const existingMarks = markState.filter((mark) => Boolean(mark.markId));
      const replacementMark = correction && correction.sessionId === sessionId
        ? markState.find((mark) => mark.markType === correction.mark.markType && !mark.markId) || null
        : null;

      if (!existingMarks.length && !replacementMark) return;

      if (existingMarks.length) {
        const section = document.createElement('section');
        section.className = 'review-form';
        section.dataset.attendanceCorrectionControls = 'true';

        const heading = document.createElement('h3');
        heading.textContent = 'Marcaciones registradas';
        section.appendChild(heading);

        const explanation = document.createElement('p');
        explanation.className = 'review-hint';
        explanation.textContent = 'Elimina únicamente la marcación que necesites corregir. Solo aparecen las horas que están registradas.';
        section.appendChild(explanation);

        const actions = document.createElement('div');
        actions.className = 'risk-row';
        existingMarks.forEach((mark) => actions.appendChild(deleteMarkForm(mark, mark.markId, reviewAction)));
        section.appendChild(actions);
        reviewContent.prepend(section);

        const clearAll = clearAllDetails(reviewAction);
        reviewContent.appendChild(clearAll);
      }

      if (replacementMark) {
        const replacementForm = addMarkForm(replacementMark, reviewAction);
        const firstControl = reviewContent.querySelector('[data-attendance-correction-controls="true"]');
        if (firstControl) firstControl.insertAdjacentElement('afterend', replacementForm);
        else reviewContent.prepend(replacementForm);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
