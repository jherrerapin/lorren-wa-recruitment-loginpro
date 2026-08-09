'use strict';

(function installAttendanceClearMarks() {
  const MARKS = Object.freeze([
    { markType: 'ARRIVAL', label: 'Entrada', datasetKey: 'arrivalMarkId' },
    { markType: 'BREAK_START', label: 'Inicio de almuerzo', datasetKey: 'breakStartMarkId' },
    { markType: 'BREAK_END', label: 'Fin de almuerzo', datasetKey: 'breakEndMarkId' },
    { markType: 'DEPARTURE', label: 'Salida', datasetKey: 'departureMarkId' }
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
    form.className = 'review-form';
    form.method = 'post';
    form.action = reviewAction;
    form.appendChild(hiddenInput('action', action));
    form.appendChild(hiddenInput('markType', markType));
    appendFilters(form);
    return form;
  }

  function deleteMarkForm(mark, markId, reviewAction) {
    const form = correctionForm('DELETE_MARK', mark.markType, reviewAction);
    form.dataset.attendanceDeleteMark = mark.markType;
    form.appendChild(hiddenInput('markId', markId));

    const heading = document.createElement('strong');
    heading.textContent = mark.label;
    form.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'review-hint';
    hint.textContent = 'Esta hora está registrada. Puedes eliminar solo esta marcación y conservar todas las demás.';
    form.appendChild(hint);

    const button = document.createElement('button');
    button.className = 'btn btn-danger';
    button.type = 'submit';
    button.textContent = `Eliminar solo ${mark.label.toLowerCase()}`;
    form.appendChild(button);

    form.addEventListener('submit', (event) => {
      const confirmed = window.confirm(`¿Eliminar solo ${mark.label.toLowerCase()}? Las demás marcaciones de la jornada se conservarán.`);
      if (!confirmed) event.preventDefault();
    });
    return form;
  }

  function addMarkForm(mark, reviewAction) {
    const form = correctionForm('ADD_MARK', mark.markType, reviewAction);
    form.dataset.attendanceAddMark = mark.markType;

    const heading = document.createElement('strong');
    heading.textContent = `${mark.label} pendiente de corrección`;
    form.appendChild(heading);

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
    button.textContent = `Registrar nueva ${mark.label.toLowerCase()}`;
    form.appendChild(button);
    return form;
  }

  function clearAllForm(reviewAction) {
    const form = document.createElement('form');
    form.className = 'review-form';
    form.method = 'post';
    form.action = reviewAction;
    form.dataset.attendanceClearForm = 'true';
    form.appendChild(hiddenInput('action', 'CLEAR'));
    appendFilters(form);

    const heading = document.createElement('h3');
    heading.textContent = 'Eliminar toda la jornada';
    form.appendChild(heading);

    const explanation = document.createElement('p');
    explanation.className = 'review-hint';
    explanation.textContent = 'Usa esta opción solo si necesitas reemplazar la jornada completa. Elimina entrada, almuerzo y salida; la asignación y la auditoría se conservan.';
    form.appendChild(explanation);

    const button = document.createElement('button');
    button.className = 'btn btn-danger';
    button.type = 'submit';
    button.textContent = 'Eliminar todas las marcaciones';
    form.appendChild(button);

    form.addEventListener('submit', (event) => {
      const confirmed = window.confirm('¿Eliminar todas las marcaciones de esta jornada? Podrás volver a registrar las horas; la auditoría se conservará.');
      if (!confirmed) event.preventDefault();
    });
    return form;
  }

  function install() {
    document.querySelectorAll('.review-content[data-attendance-review-action]').forEach((reviewContent) => {
      if (reviewContent.querySelector('[data-attendance-correction-controls="true"]')) return;
      const reviewAction = reviewContent.dataset.attendanceReviewAction;
      if (!reviewAction) return;

      const markState = MARKS.map((mark) => ({
        ...mark,
        markId: reviewContent.dataset[mark.datasetKey] || ''
      }));
      const hasAnyMark = markState.some((mark) => Boolean(mark.markId));
      const lastReviewAction = reviewContent.dataset.lastReviewAction || '';
      const granularCorrectionActive = hasAnyMark
        || lastReviewAction === 'WORKDAY_DELETE_MARK'
        || lastReviewAction === 'WORKDAY_ADD_MARK';
      if (!granularCorrectionActive) return;

      const section = document.createElement('section');
      section.className = 'review-form';
      section.dataset.attendanceCorrectionControls = 'true';

      const heading = document.createElement('h3');
      heading.textContent = 'Corregir una marcación individual';
      section.appendChild(heading);

      const explanation = document.createElement('p');
      explanation.className = 'review-hint';
      explanation.textContent = 'Elimina únicamente la hora equivocada. Las otras marcaciones se mantienen; después registra solo la nueva hora que falta.';
      section.appendChild(explanation);

      markState.forEach((mark) => {
        section.appendChild(mark.markId
          ? deleteMarkForm(mark, mark.markId, reviewAction)
          : addMarkForm(mark, reviewAction));
      });

      if (hasAnyMark) section.appendChild(clearAllForm(reviewAction));
      reviewContent.appendChild(section);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
