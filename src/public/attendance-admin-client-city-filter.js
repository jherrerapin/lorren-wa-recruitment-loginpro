'use strict';

(() => {
  const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
  const STYLE_ID = 'attendance-client-city-filter-style';

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .filter-grid.attendance-filter-grid-compact{grid-template-columns:repeat(5,minmax(0,1fr))}
      @media(max-width:1100px){.filter-grid.attendance-filter-grid-compact{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:700px){.filter-grid.attendance-filter-grid-compact{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function selectedCityFromLocation() {
    return new URLSearchParams(window.location.search).get('city') || 'ALL';
  }

  function syncCityIntoPostForms(city) {
    document.querySelectorAll('form[method="post"]').forEach((form) => {
      const action = String(form.getAttribute('action') || '');
      if (!action.startsWith(ATTENDANCE_PATH)) return;
      let input = form.querySelector('input[name="city"][data-attendance-city-filter]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'city';
        input.dataset.attendanceCityFilter = 'true';
        form.appendChild(input);
      }
      input.value = city || 'ALL';
    });
  }

  function install() {
    const form = document.querySelector('.filter-card form[method="get"]');
    const grid = form?.querySelector('.filter-grid');
    const clientSelect = form?.querySelector('select[name="client"]');
    if (!form || !grid || !clientSelect || form.querySelector('[data-attendance-city-field]')) return;

    installStyles();

    const field = document.createElement('div');
    field.className = 'field attendance-city-field';
    field.dataset.attendanceCityField = 'true';

    const label = document.createElement('label');
    label.htmlFor = 'attendanceCityFilter';
    label.textContent = 'Sucursal';

    const select = document.createElement('select');
    select.id = 'attendanceCityFilter';
    select.name = 'city';
    select.setAttribute('aria-label', 'Sucursal');

    field.append(label, select);
    clientSelect.closest('.field')?.insertAdjacentElement('afterend', field);

    const renderCities = (cities = [], requestedCity = 'ALL') => {
      const normalizedCities = [...new Set((Array.isArray(cities) ? cities : [])
        .map((city) => String(city || '').trim())
        .filter(Boolean))];

      select.replaceChildren();
      const allOption = document.createElement('option');
      allOption.value = 'ALL';
      allOption.textContent = 'Todas las sucursales';
      select.appendChild(allOption);

      normalizedCities.forEach((city) => {
        const option = document.createElement('option');
        option.value = city;
        option.textContent = city;
        select.appendChild(option);
      });

      select.disabled = false;
      select.value = requestedCity === 'ALL' || normalizedCities.includes(requestedCity)
        ? requestedCity
        : 'ALL';
      syncCityIntoPostForms(select.value);
    };

    const loadCities = async (requestedCity = 'ALL') => {
      select.disabled = true;
      select.replaceChildren();
      const loading = document.createElement('option');
      loading.value = 'ALL';
      loading.textContent = 'Cargando sucursales…';
      select.appendChild(loading);

      const params = new URLSearchParams();
      const from = form.querySelector('input[name="from"]')?.value;
      const to = form.querySelector('input[name="to"]')?.value;
      if (from) params.set('from', from);
      if (to) params.set('to', to);

      try {
        const response = await fetch(`${ATTENDANCE_PATH}/filter-options?${params.toString()}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        const payload = await response.json();
        if (!response.ok || payload?.ok !== true) throw new Error('attendance_filter_options_failed');
        renderCities(payload.cities, requestedCity);
      } catch (error) {
        console.warn('[ATTENDANCE_CITY_FILTER_LOAD_FAILED]', { code: error?.message || 'unknown' });
        renderCities([], 'ALL');
      }
    };

    select.addEventListener('change', () => syncCityIntoPostForms(select.value));

    loadCities(selectedCityFromLocation());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
