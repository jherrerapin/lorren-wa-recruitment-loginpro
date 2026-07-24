'use strict';

(() => {
  const RUNTIME_FLAG = '__lorrenAttendanceMapReliabilityLoaded';
  const GEOCODING_ENDPOINT = '/admin/operaciones/asistencia/geocodificar';
  const TARGET_ACCURACY_METERS = 20;
  const LOCATION_SAMPLE_TIMEOUT_MS = 15_000;
  const TILE_ERROR_THRESHOLD = 2;

  if (window[RUNTIME_FLAG] || !window.L) return;
  window[RUNTIME_FLAG] = true;

  const leaflet = window.L;
  const originalMapFactory = leaflet.map;
  const originalFitBounds = leaflet.Map.prototype.fitBounds;
  const originalTileLayerFactory = leaflet.tileLayer;
  const pendingViewportFrames = new WeakMap();

  function finiteCoordinate(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  }

  function formatCoordinate(value) {
    return Number(value).toFixed(7);
  }

  function requestFrame(callback) {
    return window.requestAnimationFrame
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(callback, 16);
  }

  function cancelFrame(frameId) {
    if (window.cancelAnimationFrame) window.cancelAnimationFrame(frameId);
    else window.clearTimeout(frameId);
  }

  function refreshMapViewport(map) {
    if (!map?.getContainer) return;
    const previousFrame = pendingViewportFrames.get(map);
    if (previousFrame) cancelFrame(previousFrame);

    const firstFrame = requestFrame(() => {
      const secondFrame = requestFrame(() => {
        pendingViewportFrames.delete(map);
        const container = map.getContainer();
        if (!container?.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) return;
        map.invalidateSize({ pan: false, debounceMoveend: true });
        if (map.__lorrenAttendanceBounds) {
          originalFitBounds.call(
            map,
            map.__lorrenAttendanceBounds,
            { ...(map.__lorrenAttendanceFitOptions || {}), animate: false }
          );
        }
      });
      pendingViewportFrames.set(map, secondFrame);
    });
    pendingViewportFrames.set(map, firstFrame);
  }

  leaflet.map = function reliableAttendanceMap(...args) {
    const map = originalMapFactory.apply(this, args);
    const container = map.getContainer();
    if (container) container.__lorrenAttendanceMap = map;
    return map;
  };
  Object.assign(leaflet.map, originalMapFactory);

  leaflet.Map.prototype.fitBounds = function reliableFitBounds(bounds, options = {}) {
    this.__lorrenAttendanceBounds = bounds;
    this.__lorrenAttendanceFitOptions = options;
    refreshMapViewport(this);
    return this;
  };

  function tileWarningElement(map) {
    const container = map.getContainer();
    if (!container?.parentElement) return null;
    let warning = container.parentElement.querySelector('[data-attendance-tile-warning]');
    if (warning) return warning;

    warning = document.createElement('div');
    warning.dataset.attendanceTileWarning = 'true';
    warning.hidden = true;
    warning.setAttribute('role', 'status');
    warning.style.cssText = [
      'margin-top:8px',
      'padding:10px 12px',
      'border:1px solid #f2c66d',
      'border-radius:10px',
      'background:#fff8e7',
      'color:#76520b',
      'font-size:12px',
      'line-height:1.45'
    ].join(';');
    warning.textContent = 'El fondo cartográfico no respondió. Los puntos y coordenadas siguen siendo válidos; usa los enlaces de verificación mostrados debajo.';
    container.insertAdjacentElement('afterend', warning);
    return warning;
  }

  function observeTileLayer(map, layer) {
    if (!map || !layer || layer.__lorrenAttendanceObserved) return;
    layer.__lorrenAttendanceObserved = true;
    let tileErrors = 0;

    layer.on('tileerror', () => {
      tileErrors += 1;
      if (tileErrors < TILE_ERROR_THRESHOLD) return;
      const warning = tileWarningElement(map);
      if (warning) warning.hidden = false;
    });
    layer.on('tileload', () => {
      tileErrors = 0;
      const warning = tileWarningElement(map);
      if (warning) warning.hidden = true;
    });
  }

  leaflet.tileLayer = function reliableAttendanceTileLayer(...args) {
    const layer = originalTileLayerFactory.apply(this, args);
    const originalAddTo = layer.addTo;
    layer.addTo = function reliableTileLayerAddTo(map) {
      observeTileLayer(map, layer);
      return originalAddTo.call(layer, map);
    };
    return layer;
  };
  Object.assign(leaflet.tileLayer, originalTileLayerFactory);

  function mapsLink(latitude, longitude, label) {
    const link = document.createElement('a');
    link.href = `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    link.style.cssText = 'font-weight:800;color:#1d4ed8;text-decoration:none;';
    return link;
  }

  function coordinateLine(label, latitude, longitude, linkLabel) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
    const text = document.createElement('span');
    text.textContent = `${label}: ${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
    row.append(text, mapsLink(latitude, longitude, linkLabel));
    return row;
  }

  function installCoordinateDiagnostics() {
    document.querySelectorAll('.attendance-map[data-point-lat][data-point-lng]').forEach((container) => {
      if (container.dataset.coordinateDiagnosticsInstalled === 'true') return;
      const pointLat = finiteCoordinate(container.dataset.pointLat, -90, 90);
      const pointLng = finiteCoordinate(container.dataset.pointLng, -180, 180);
      if (pointLat === null || pointLng === null) return;

      container.dataset.coordinateDiagnosticsInstalled = 'true';
      const panel = document.createElement('div');
      panel.dataset.attendanceCoordinateDiagnostics = 'true';
      panel.style.cssText = [
        'margin-top:8px',
        'padding:10px 12px',
        'border:1px solid #dbe3eb',
        'border-radius:10px',
        'background:#f8fafc',
        'color:#475569',
        'font-size:11px',
        'line-height:1.5',
        'display:grid',
        'gap:5px'
      ].join(';');
      panel.append(coordinateLine('Punto configurado', pointLat, pointLng, 'Abrir punto'));

      const markLat = finiteCoordinate(container.dataset.markLat, -90, 90);
      const markLng = finiteCoordinate(container.dataset.markLng, -180, 180);
      if (markLat !== null && markLng !== null) {
        panel.append(coordinateLine('Ubicación reportada', markLat, markLng, 'Abrir marcación'));
      }

      const legend = container.parentElement?.querySelector('.map-legend');
      if (legend) legend.insertAdjacentElement('afterend', panel);
      else container.insertAdjacentElement('afterend', panel);
    });
  }

  function statusElement(form) {
    return form?.querySelector('.attendance-map-status') || null;
  }

  function setStatus(form, message, isError = false) {
    const status = statusElement(form);
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function pointConfigMap(form) {
    return form?.querySelector('.attendance-map')?.__lorrenAttendanceMap || null;
  }

  function selectPoint(form, latitude, longitude, message) {
    const map = pointConfigMap(form);
    const lat = finiteCoordinate(latitude, -90, 90);
    const lng = finiteCoordinate(longitude, -180, 180);
    if (!map || lat === null || lng === null) {
      setStatus(form, 'No fue posible aplicar esa ubicación al mapa.', true);
      return false;
    }
    map.fire('click', { latlng: leaflet.latLng(lat, lng) });
    setStatus(form, message || `Punto seleccionado: ${formatCoordinate(lat)}, ${formatCoordinate(lng)}.`);
    refreshMapViewport(map);
    return true;
  }

  function removeGeocodingResults(form) {
    form?.querySelector('[data-attendance-geocode-results]')?.remove();
  }

  function providerLabel(result) {
    const providers = {
      'ideca-placa': 'Catastro Bogotá',
      'ideca-legacy': 'IDECA',
      arcgis: 'ArcGIS',
      nominatim: 'OpenStreetMap'
    };
    const provider = providers[result?.provider] || 'Proveedor geográfico';
    return result?.precision === 'address' ? `${provider} · dirección exacta` : `${provider} · aproximada`;
  }

  function renderGeocodingResults(form, input, results) {
    removeGeocodingResults(form);
    const list = document.createElement('div');
    list.dataset.attendanceGeocodeResults = 'true';
    list.style.cssText = [
      'display:grid',
      'gap:8px',
      'margin-top:8px',
      'padding:10px',
      'border:1px solid #cfd8e3',
      'border-radius:12px',
      'background:#fff'
    ].join(';');

    const heading = document.createElement('strong');
    heading.textContent = 'Confirma el resultado correcto';
    heading.style.cssText = 'color:#1e2d3d;font-size:13px;';
    list.append(heading);

    results.forEach((result) => {
      const latitude = finiteCoordinate(result?.lat, -90, 90);
      const longitude = finiteCoordinate(result?.lon, -180, 180);
      if (latitude === null || longitude === null) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.style.cssText = [
        'width:100%',
        'padding:10px 12px',
        'border:1px solid #dbe3eb',
        'border-radius:10px',
        'background:#f8fafc',
        'text-align:left',
        'cursor:pointer'
      ].join(';');

      const title = document.createElement('span');
      title.textContent = result.display_name || 'Ubicación encontrada';
      title.style.cssText = 'display:block;color:#172033;font-weight:800;font-size:13px;';
      const meta = document.createElement('span');
      meta.textContent = `${providerLabel(result)} · ${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
      meta.style.cssText = 'display:block;margin-top:3px;color:#64748b;font-size:11px;';
      button.append(title, meta);

      button.addEventListener('click', () => {
        const applied = selectPoint(
          form,
          latitude,
          longitude,
          'Ubicación confirmada. Revisa el marcador en la entrada real y guarda la configuración.'
        );
        if (!applied) return;
        if (input) input.value = result.display_name || input.value;
        removeGeocodingResults(form);
      });
      list.append(button);
    });

    const actions = form.querySelector('.attendance-map-actions');
    if (actions) actions.insertAdjacentElement('afterend', list);
  }

  async function handleAddressSearch(button) {
    const form = button.closest('.attendance-map-form');
    const input = form?.querySelector('.attendance-address-search');
    const query = String(input?.value || '').trim();
    if (!form || query.length < 4) {
      setStatus(form, 'Escribe una dirección o nombre de lugar más específico.', true);
      input?.focus();
      return;
    }

    button.disabled = true;
    removeGeocodingResults(form);
    setStatus(form, 'Buscando coincidencias para que confirmes el punto correcto…');
    try {
      const params = new URLSearchParams({ q: query });
      const response = await fetch(`${GEOCODING_ENDPOINT}?${params.toString()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('attendance_geocoding_unavailable');
      const payload = await response.json();
      const results = Array.isArray(payload) ? payload : [];
      if (!results.length) {
        setStatus(form, 'No encontramos una coincidencia confiable. Usa tu ubicación o selecciona la entrada directamente en el mapa.', true);
        return;
      }
      renderGeocodingResults(form, input, results);
      setStatus(form, 'Selecciona una de las coincidencias. Lórren no guardará automáticamente el primer resultado.');
    } catch {
      setStatus(form, 'La búsqueda no está disponible. Usa tu ubicación o selecciona el punto directamente en el mapa.', true);
    } finally {
      button.disabled = false;
    }
  }

  function handleCurrentLocation(button) {
    const form = button.closest('.attendance-map-form');
    if (!form || !navigator.geolocation) {
      setStatus(form, 'Este navegador no permite obtener la ubicación. Selecciona el punto directamente en el mapa.', true);
      return;
    }

    button.disabled = true;
    removeGeocodingResults(form);
    let bestPosition = null;
    let settled = false;
    let watchId = null;

    const cleanup = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      window.clearTimeout(timeoutId);
      button.disabled = false;
    };

    const finish = (errorMessage = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!bestPosition) {
        setStatus(form, errorMessage || 'No fue posible obtener una ubicación confiable. Revisa el permiso y el GPS.', true);
        return;
      }

      const accuracy = Math.round(bestPosition.coords.accuracy || 0);
      selectPoint(
        form,
        bestPosition.coords.latitude,
        bestPosition.coords.longitude,
        accuracy <= TARGET_ACCURACY_METERS
          ? `Ubicación confirmada con precisión aproximada de ${accuracy} m. Revisa la entrada y guarda.`
          : `La mejor lectura alcanzó ${accuracy} m de precisión. Ajusta el marcador manualmente antes de guardar.`
      );
    };

    const timeoutId = window.setTimeout(
      () => finish('El GPS no entregó una lectura dentro del tiempo esperado.'),
      LOCATION_SAMPLE_TIMEOUT_MS
    );

    setStatus(form, 'Mejorando la precisión del GPS… mantén el celular quieto y cerca de una ventana o espacio abierto.');
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const accuracy = Number(position.coords.accuracy);
        if (!bestPosition || (Number.isFinite(accuracy) && accuracy < Number(bestPosition.coords.accuracy))) {
          bestPosition = position;
        }
        const bestAccuracy = Math.round(bestPosition.coords.accuracy || 0);
        setStatus(form, `Mejor lectura disponible: ${bestAccuracy} m. Esperando mayor precisión…`);
        if (bestAccuracy <= TARGET_ACCURACY_METERS) finish();
      },
      (error) => {
        if (error?.code === 1) finish('Permiso de ubicación rechazado. Actívalo o selecciona el punto en el mapa.');
      },
      { enableHighAccuracy: true, timeout: LOCATION_SAMPLE_TIMEOUT_MS, maximumAge: 0 }
    );
  }

  document.addEventListener('click', (event) => {
    const searchButton = event.target.closest?.('.attendance-search-button');
    if (searchButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      handleAddressSearch(searchButton);
      return;
    }

    const locationButton = event.target.closest?.('.attendance-current-location');
    if (locationButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      handleCurrentLocation(locationButton);
    }
  }, true);

  function installDetailsRefresh() {
    document.querySelectorAll('[data-map-details], details.attendance-config').forEach((details) => {
      if (details.dataset.attendanceReliableToggle === 'true') return;
      details.dataset.attendanceReliableToggle = 'true';
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        const map = details.querySelector('.attendance-map')?.__lorrenAttendanceMap;
        if (map) refreshMapViewport(map);
        else window.setTimeout(() => {
          const delayedMap = details.querySelector('.attendance-map')?.__lorrenAttendanceMap;
          if (delayedMap) refreshMapViewport(delayedMap);
        }, 0);
      });
    });
  }

  function initialize() {
    installCoordinateDiagnostics();
    installDetailsRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
