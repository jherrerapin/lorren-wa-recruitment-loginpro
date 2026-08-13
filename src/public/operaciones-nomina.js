(() => {
  const periodType = document.getElementById('periodType');
  const customDates = document.querySelectorAll('.custom-date');
  const anchorDateField = document.getElementById('anchorDateField');
  function syncPeriodFields() {
    const custom = periodType?.value === 'CUSTOM';
    customDates.forEach((field) => { field.style.display = custom ? 'flex' : 'none'; });
    if (anchorDateField) anchorDateField.style.display = custom ? 'none' : 'flex';
  }
  if (periodType) {
    periodType.addEventListener('change', syncPeriodFields);
    syncPeriodFields();
  }

  const monthFormatter = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dateFormatter = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const parseDateKey = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const parsed = new Date(`${value}T12:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const dateKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  const closeDatePicker = (picker) => {
    picker.classList.remove('open');
    const trigger = picker.querySelector('[data-date-trigger]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  };

  document.querySelectorAll('[data-payroll-date-picker]').forEach((picker) => {
    const input = picker.querySelector('[data-date-value]');
    const trigger = picker.querySelector('[data-date-trigger]');
    const title = picker.querySelector('[data-date-title]');
    const days = picker.querySelector('[data-date-days]');
    if (!input || !trigger || !title || !days) return;
    const selectedAtStart = parseDateKey(input.value) || new Date();
    let cursor = new Date(Date.UTC(selectedAtStart.getUTCFullYear(), selectedAtStart.getUTCMonth(), 1, 12));

    const updateTrigger = () => {
      const selected = parseDateKey(input.value);
      trigger.textContent = selected ? dateFormatter.format(selected) : 'Seleccionar fecha';
    };

    const renderCalendar = () => {
      title.textContent = monthFormatter.format(cursor);
      days.innerHTML = '';
      const firstOfMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1, 12));
      const mondayOffset = (firstOfMonth.getUTCDay() + 6) % 7;
      const firstVisible = new Date(firstOfMonth.getTime());
      firstVisible.setUTCDate(firstVisible.getUTCDate() - mondayOffset);
      for (let index = 0; index < 42; index += 1) {
        const current = new Date(firstVisible.getTime());
        current.setUTCDate(firstVisible.getUTCDate() + index);
        const key = dateKey(current);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'date-day';
        button.textContent = String(current.getUTCDate());
        button.setAttribute('aria-label', dateFormatter.format(current));
        if (current.getUTCMonth() !== cursor.getUTCMonth()) button.classList.add('outside');
        if (key === input.value) button.classList.add('selected');
        button.addEventListener('click', () => {
          input.value = key;
          cursor = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1, 12));
          updateTrigger();
          closeDatePicker(picker);
        });
        days.appendChild(button);
      }
    };

    trigger.addEventListener('click', () => {
      const opening = !picker.classList.contains('open');
      document.querySelectorAll('[data-payroll-date-picker].open').forEach((other) => closeDatePicker(other));
      if (opening) {
        const selected = parseDateKey(input.value);
        if (selected) cursor = new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth(), 1, 12));
        renderCalendar();
        picker.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    picker.querySelector('[data-date-prev]')?.addEventListener('click', () => { cursor.setUTCMonth(cursor.getUTCMonth() - 1); renderCalendar(); });
    picker.querySelector('[data-date-next]')?.addEventListener('click', () => { cursor.setUTCMonth(cursor.getUTCMonth() + 1); renderCalendar(); });
    updateTrigger();
    renderCalendar();
  });

  document.addEventListener('click', (event) => {
    document.querySelectorAll('[data-payroll-date-picker].open').forEach((picker) => {
      if (!picker.contains(event.target)) closeDatePicker(picker);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('[data-payroll-date-picker].open').forEach((picker) => closeDatePicker(picker));
  });

  const clientSelect = document.getElementById('clientId');
  const operationSelect = document.getElementById('operationPointId');
  function syncOperations() {
    if (!clientSelect || !operationSelect) return;
    const clientId = clientSelect.value;
    [...operationSelect.options].forEach((option, index) => {
      if (!index) return;
      option.hidden = Boolean(clientId && option.dataset.client !== clientId);
    });
    if (operationSelect.selectedOptions[0]?.hidden) operationSelect.value = '';
  }
  if (clientSelect && operationSelect) {
    clientSelect.addEventListener('change', syncOperations);
    syncOperations();
  }
})();