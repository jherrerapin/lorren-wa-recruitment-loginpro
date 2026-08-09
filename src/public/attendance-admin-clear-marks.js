'use strict';

(function installAttendanceClearMarks() {
  function hiddenInput(name, value) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    return input;
  }

  function install() {
    document.querySelectorAll('.attendance-validation-form').forEach((validationForm) => {
      const reviewContent = validationForm.closest('.review-content');
      if (!reviewContent || reviewContent.querySelector('[data-attendance-clear-form="true"]')) return;

      const form = document.createElement('form');
      form.className = 'review-form';
      form.method = 'post';
      form.action = validationForm.action;
      form.dataset.attendanceClearForm = 'true';
      form.appendChild(hiddenInput('action', 'CLEAR'));

      ['from', 'to', 'status', 'client', 'q'].forEach((name) => {
        const source = validationForm.querySelector(`input[name="${name}"]`);
        if (source) form.appendChild(hiddenInput(name, source.value));
      });

      const heading = document.createElement('h3');
      heading.textContent = 'Corregir horas registradas';
      form.appendChild(heading);

      const explanation = document.createElement('p');
      explanation.className = 'review-hint';
      explanation.textContent = 'Elimina la entrada, el almuerzo y la salida de esta sesión. La asignación y la auditoría se conservan; después podrás registrar nuevamente la jornada manual.';
      form.appendChild(explanation);

      const button = document.createElement('button');
      button.className = 'btn btn-danger';
      button.type = 'submit';
      button.textContent = 'Eliminar marcaciones';
      form.appendChild(button);

      form.addEventListener('submit', (event) => {
        const confirmed = window.confirm('¿Eliminar las marcaciones de esta jornada? Podrás volver a registrar las horas; la auditoría se conservará.');
        if (!confirmed) event.preventDefault();
      });

      reviewContent.appendChild(form);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
