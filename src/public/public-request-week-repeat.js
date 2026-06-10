(() => {
  const form = document.getElementById('publicServiceRequestForm');
  const shiftList = document.getElementById('shiftList');
  if (!form || !shiftList) return;

  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  function toDateValue(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function startOfCurrentWeek() {
    const today = new Date();
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return date;
  }

  function currentWeekDates() {
    const start = startOfCurrentWeek();
    return Array.from({ length: 7 }, (_item, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }

  function makeInput(name, value) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    input.className = 'repeat-generated-input';
    return input;
  }

  function renderDays(row) {
    const baseInput = row.querySelector('input[name="serviceDateBlock"]');
    const box = row.querySelector('[data-week-repeat-days]');
    if (!baseInput || !box) return;

    const baseValue = baseInput.value;
    const todayValue = toDateValue(new Date());
    const dates = currentWeekDates();
    const isCurrentWeek = dates.some((date) => toDateValue(date) === baseValue);
    box.innerHTML = '';

    if (!baseValue) {
      box.textContent = 'Selecciona primero la fecha base.';
      return;
    }
    if (!isCurrentWeek) {
      box.textContent = 'La repetición solo aplica para la semana actual.';
      return;
    }

    dates.forEach((date) => {
      const value = toDateValue(date);
      const label = document.createElement('label');
      label.className = 'week-day-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = value;
      checkbox.className = 'repeat-week-day';
      checkbox.disabled = value === baseValue || value < todayValue;
      label.classList.toggle('is-disabled', checkbox.disabled);
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(`${dayNames[date.getDay()]} ${date.getDate()}`));
      box.appendChild(label);
    });
  }

  function attach(row) {
    const toggle = row.querySelector('[data-week-repeat-toggle]');
    const box = row.querySelector('[data-week-repeat-days]');
    const baseInput = row.querySelector('input[name="serviceDateBlock"]');
    if (!toggle || !box || !baseInput) return;

    toggle.addEventListener('change', () => {
      box.hidden = !toggle.checked;
      if (toggle.checked) renderDays(row);
    });
    baseInput.addEventListener('change', () => {
      if (toggle.checked) renderDays(row);
    });
  }

  shiftList.querySelectorAll('.shift-row').forEach(attach);

  const observer = new MutationObserver(() => {
    shiftList.querySelectorAll('.shift-row').forEach((row) => {
      if (row.dataset.weekRepeatReady) return;
      row.dataset.weekRepeatReady = '1';
      attach(row);
    });
  });
  observer.observe(shiftList, { childList: true });

  form.addEventListener('submit', () => {
    form.querySelectorAll('.repeat-generated-input').forEach((node) => node.remove());
    shiftList.querySelectorAll('.shift-row').forEach((row) => {
      const toggle = row.querySelector('[data-week-repeat-toggle]');
      if (!toggle?.checked) return;
      const qty = row.querySelector('input[name="requiredWorkers"]')?.value || '1';
      const start = row.querySelector('input[name="startTime"]')?.value || '';
      const end = row.querySelector('input[name="endTime"]')?.value || '';
      row.querySelectorAll('.repeat-week-day:checked').forEach((checkbox) => {
        form.appendChild(makeInput('serviceDateBlock', checkbox.value));
        form.appendChild(makeInput('requiredWorkers', qty));
        form.appendChild(makeInput('startTime', start));
        form.appendChild(makeInput('endTime', end));
      });
    });
  });
})();
