'use strict';

(() => {
  const RUNTIME_FLAG = '__lorrenAttendanceMapReliabilityLoaded';
  const LEAFLET_CSS_URL = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
  const LEAFLET_CSS_INTEGRITY = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  const LEAFLET_JS_INTEGRITY = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
  const GEOCODING_ENDPOINT = '/admin/operaciones/asistencia/geocodificar';
  const TARGET_ACCURACY_METERS = 20;
  const LOCATION_SAMPLE_TIMEOUT_MS = 15_000;
  const TILE_ERROR_THRESHOLD = 2;
  const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const IDECA_TILE_URL = 'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/Mapa_Referencia/mapa_base_3857/MapServer/tile/{z}/{y}/{x}';
  const BOGOTA_BOUNDS = Object.freeze({ south: 4.45, north: 4.86, west: -74.32, east: -73.90 });

  function requestFrame(callback) {
    return window.requestAnimationFrame
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(callback, 16);
  }

  function ensureLeafletStylesheet() {
    if (document.querySelector('link[data-lorren-leaflet-fallback="true"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS_URL;
    link.integrity = LEAFLET_CSS_INTEGRITY;
    link.crossOrigin = '';
    link.dataset.lorrenLeafletFallback = 'true';
    document.head.appendChild(link);
  }

  function loadLeafletFallback(callback) {
    const existing = document.querySelector('script[data-lorren-leaflet-fallback="true"]');
    if (existing) {
      existing.addEventListener('load', callback, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS_FALLBACK_URL;
    script.integrity = LEAFLET_JS_INTEGRITY;
    script.crossOrigin = '';
    script.dataset.lorrenLeafletFallback = 'true';
    script.addEventListener('load', callback, { once: true });
    script.addEventListener('error', () => {
      document.querySelectorAll('.attendance-map-status').forEach((status) => {
        status.textContent = 'No fue posible cargar el componente cartográfico. Recarga la página; las coordenadas guardadas no se modificaron.';
        status.classList.add('is-error');
      });
    }, { once: true });
    document.head.appendChild(script);
  }

  ensureLeafletStylesheet();
  if (window[RUNTIME_FLAG]) return;
  if (!window.L) {
    loadLeafletFallback(() => startRuntime());
    return;
  }
  startRuntime();

  function startRuntime() {
    if (window[RUNTIME_FLAG] || !window.L) return;
    window[RUNTIME_FLAG] = true;

    const leaflet = window.L;
    const originalMapFactory = leaflet.map;
    const originalFitBounds = leaflet.Map.prototype.fitBounds;
    const originalTileLayerFactory = leaflet.tileLayer;
    const pendingViewportFrames = new WeakMap();
    const baseLayerStates = new WeakMap();
    const observedContainers = new WeakSet();

    function finiteCoordinate(value, min, max) {
      const number = Number(value);
      return Number.isFinite(number) && number >= min && number <= max ? number : null;
    }

    function formatCoordinate(value) {
      return Number(value).toFixed(7);
    }

    function comparableText(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^0-9A-Za-z]+/g, ' ')
        .trim()
        .toLocaleLowerCase('es-CO');
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

    function installResizeObserver(map) {
      const container = map?.getContainer?.();
      if (!container || observedContainers.has(container) || typeof window.ResizeObserver !== 'function') return;
      observedContainers.add(container);
      const observer = new window.ResizeObserver((entries) => {
        const visible = entries.some((entry) => entry.contentRect.width > 0 && entry.contentRect.height > 0);
        if (visible) refreshMapViewport(map);
      });
      observer.observe(container);
      map.once('unload', () => observer.disconnect());
    }

    leaflet.map = function reliableAttendanceMap(...args) {
      const map = originalMapFactory.apply(this, args);
      const container = map.getContainer();
      if (container) container.__lorrenAttendanceMap = map;
      installResizeObserver(map);
      return map;
    };
    Object.assign(leaflet.map, originalMapFactory);

    leaflet.Map.prototype.fitBounds = function reliableFitBounds(bounds, options = {}) {
      this.__lorrenAttendanceBounds = bounds;
      this.__lorrenAttendanceFitOptions = options;
      refreshMapViewport(this);
      return this;
    };

    function inferCityFromSearchInput(input) {
      const initialValue = String(input?.defaultValue || input?.value || '').trim();
      const parts = initialValue.split(',').map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return '';
      if (comparableText(parts.at(-1)) === 'colombia') parts.pop();
      return parts.length >= 2 ? parts.at(-1) : '';
    }

    function mapContext(map) {
      const container = map?.getContainer?.();
      const form = container?.closest?.('.attendance-map-form');
      const input = form?.querySelector?.('.attendance-address-search');
      const city = form?.dataset?.attendanceSearchCity
        || inferCityFromSearchInput(input)
        || container?.dataset?.city
        || '';
      if (form && city && !form.dataset.attendanceSearchCity) form.dataset.attendanceSearchCity = city;

      const latitude = finiteCoordinate(
        container?.dataset?.pointLat
          ?? form?.querySelector?.('[name="attendanceLatitude"]')?.value,
        -90,
        90
      );
      const longitude = finiteCoordinate(
        container?.dataset?.pointLng
          ?? form?.querySelector?.('[name="attendanceLongitude"]')?.value,
        -180,
        180
      );
      return { city, latitude, longitude };
    }

    function isBogotaMap(map) {
      const context = mapContext(map);
      if (context.city) return /\bbogota\b/.test(comparableText(context.city));
      return context.latitude !== null
        && context.longitude !== null
        && context.latitude >= BOGOTA_BOUNDS.south
        && context.latitude <= BOGOTA_BOUNDS.north
        && context.longitude >= BOGOTA_BOUNDS.west
        && context.longitude <= BOGOTA_BOUNDS.east;
    }

    const providerDefinitions = Object.freeze({
      ideca: {
        label: 'Mapa oficial IDECA · UAECD',
        url: IDECA_TILE_URL,
        attribution: '&copy; IDECA · UAECD'
      },
      osm: {
        label: 'OpenStreetMap',
        url: OSM_TILE_URL,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    });

    function mapMessageElement(map, kind) {
      const container = map.getContainer();
      if (!container?.parentElement) return null;
      const selector = kind === 'provider'
        ? '[data-attendance-map-provider]'
        : '[data-attendance-tile-warning]';
      let element = container.parentElement.querySelector(selector);
      if (element) return element;

      element = document.createElement('div');
      if (kind === 'provider') element.dataset.attendanceMapProvider = 'true';
      else element.dataset.attendanceTileWarning = 'true';
      element.hidden = kind !== 'provider';
      element.setAttribute('role', 'status');
      element.style.cssText = kind === 'provider'
        ? 'margin-top:7px;color:#64748b;font-size:10px;line-height:1.35;'
        : 'margin-top:8px;padding:10px 12px;border:1px solid #f2c66d;border-radius:10px;background:#fff8e7;color:#76520b;font-size:12px;line-height:1.45;';
      container.insertAdjacentElement('afterend', element);
      return element;
    }

    function setProviderMessage(map, message) {
      const element = mapMessageElement(map, 'provider');
      if (element) element.textContent = message;
    }

    function setTileWarning(map, message, visible) {
      const warning = mapMessageElement(map, 'warning');
      if (!warning) return;
      warning.textContent = message;
      warning.hidden = !visible;
    }

    function providerOrderForMap(map, requestedUrl) {
      if (isBogotaMap(map)) return ['ideca', 'osm'];
      if (String(requestedUrl || '').includes('serviciosgis.catastrobogota.gov.co')) return ['ideca', 'osm'];
      return ['osm'];
    }

    function activateProvider(map, providerName) {
      const state = baseLayerStates.get(map);
      const definition = providerDefinitions[providerName];
      if (!state || !definition) return null;

      if (state.activeLayer) map.removeLayer(state.activeLayer);
      state.attempted.add(providerName);
      const layer = originalTileLayerFactory(definition.url, {
        ...state.options,
        attribution: definition.attribution,
        maxZoom: Math.max(19, Number(state.options?.maxZoom || 0))
      });
      state.activeLayer = layer;
      state.activeProvider = providerName;
      let errors = 0;

      setProviderMessage(map, `Fondo cartográfico: ${definition.label}.`);
      setTileWarning(map, '', false);

      layer.on('tileload', () => {
        if (state.activeLayer !== layer) return;
        errors = 0;
        setProviderMessage(map, `Fondo cartográfico activo: ${definition.label}.`);
        setTileWarning(map, '', false);
      });
      layer.on('tileerror', () => {
        if (state.activeLayer !== layer) return;
        errors += 1;
        if (errors < TILE_ERROR_THRESHOLD) return;
        const nextProvider = state.order.find((name) => !state.attempted.has(name));
        if (nextProvider) {
          setProviderMessage(map, `${definition.label} no respondió. Cambiando automáticamente de fondo…`);
          activateProvider(map, nextProvider);
          return;
        }
        setProviderMessage(map, 'Los proveedores de fondo no respondieron.');
        setTileWarning(
          map,
          'No fue posible cargar el fondo cartográfico. Los marcadores, la geocerca y las coordenadas siguen siendo válidos; vuelve a intentar más tarde.',
          true
        );
      });

      layer.addTo(map);
      return layer;
    }

    function installManagedBaseLayer(map, requestedUrl, options = {}) {
      const existing = baseLayerStates.get(map);
      if (existing?.activeLayer) return existing.activeLayer;
      const state = {
        options,
        order: providerOrderForMap(map, requestedUrl),
        attempted: new Set(),
        activeLayer: null,
        activeProvider: null
      };
      baseLayerStates.set(map, state);
      return activateProvider(map, state.order[0]);
    }

    function isManagedTileUrl(url) {
      const value = String(url || '');
      return value === OSM_TILE_URL
        || value === IDECA_TILE_URL
        || value.includes('tile.openstreetmap.org')
        || value.includes('Mapa_Referencia/mapa_base_3857/MapServer/tile');
    }

    leaflet.tileLayer = function reliableAttendanceTileLayer(url, options = {}) {
      const layer = originalTileLayerFactory.call(this, url, options);
      if (!isManagedTileUrl(url)) return layer;
      layer.addTo = function reliableTileLayerAddTo(map) {
        return installManagedBaseLayer(map, url, options) || layer;
      };
      return layer;
    };
    Object.assign(leaflet.tileLayer, originalTileLayerFactory);

    function coordinateCopyButton(latitude, longitude) {
      const coordinates = `${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Copiar coordenadas';
      button.style.cssText = 'border:0;padding:3px 7px;border-radius:7px;background:#e7eef8;color:#1d4ed8;font-size:10px;font-weight:800;cursor:pointer;';
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(coordinates);
          button.textContent = 'Copiadas';
          window.setTimeout(() => { button.textContent = 'Copiar coordenadas'; }, 1600);
        } catch {
          window.prompt('Copia estas coordenadas:', coordinates);
        }
      });
      return button;
    }

    function coordinateLine(label, latitude, longitude) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
      const text = document.createElement('span');
      text.textContent = `${label}: ${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
      row.append(text, coordinateCopyButton(latitude, longitude));
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
        panel.style.cssText = 'margin-top:8px;padding:10px 12px;border:1px solid #dbe3eb;border-radius:10px;background:#f8fafc;color:#475569;font-size:11px;line-height:1.5;display:grid;gap:5px;';
        panel.append(coordinateLine('Punto configurado', pointLat, pointLng));

        const markLat = finiteCoordinate(container.dataset.markLat, -90, 90);
        const markLng = finiteCoordinate(container.dataset.markLng, -180, 180);
        if (markLat !== null && markLng !== null) panel.append(coordinateLine('Ubicación reportada', markLat, markLng));

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
      list.style.cssText = 'display:grid;gap:8px;margin-top:8px;padding:10px;border:1px solid #cfd8e3;border-radius:12px;background:#fff;';

      const heading = document.createElement('strong');
      heading.textContent = `Confirma el resultado correcto (${results.length})`;
      heading.style.cssText = 'color:#1e2d3d;font-size:13px;';
      list.append(heading);

      results.forEach((result) => {
        const latitude = finiteCoordinate(result?.lat, -90, 90);
        const longitude = finiteCoordinate(result?.lon, -180, 180);
        if (latitude === null || longitude === null) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = 'width:100%;padding:10px 12px;border:1px solid #dbe3eb;border-radius:10px;background:#f8fafc;text-align:left;cursor:pointer;';
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
          removeGeocodingResults(form);
        });
        list.append(button);
      });

      const actions = form.querySelector('.attendance-map-actions');
      if (actions) actions.insertAdjacentElement('afterend', list);
    }

    function searchCity(form, input) {
      const existing = String(form?.dataset?.attendanceSearchCity || '').trim();
      if (existing) return existing;
      const inferred = inferCityFromSearchInput(input);
      if (form && inferred) form.dataset.attendanceSearchCity = inferred;
      return inferred;
    }

    function contextualSearchQuery(rawQuery, city) {
      const parts = [String(rawQuery || '').trim()];
      const comparableQuery = comparableText(rawQuery);
      if (city && !comparableQuery.includes(comparableText(city))) parts.push(city);
      if (!comparableQuery.includes('colombia')) parts.push('Colombia');
      return parts.filter(Boolean).join(', ');
    }

    async function handleAddressSearch(button) {
      const form = button.closest('.attendance-map-form');
      const input = form?.querySelector('.attendance-address-search');
      const rawQuery = String(input?.value || '').trim();
      if (!form || rawQuery.length < 3) {
        setStatus(form, 'Escribe una dirección, un barrio o el nombre del lugar.', true);
        input?.focus();
        return;
      }

      const city = searchCity(form, input);
      const query = contextualSearchQuery(rawQuery, city);
      button.disabled = true;
      removeGeocodingResults(form);
      setStatus(form, `Buscando “${rawQuery}”${city ? ` en ${city}` : ''}…`);
      try {
        const params = new URLSearchParams({ q: query });
        if (city) params.set('city', city);
        const response = await fetch(`${GEOCODING_ENDPOINT}?${params.toString()}`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('attendance_geocoding_unavailable');
        const payload = await response.json();
        const results = Array.isArray(payload) ? payload : [];
        if (!results.length) {
          setStatus(form, 'No encontramos una coincidencia confiable. Prueba con una referencia cercana, usa tu ubicación o toca el mapa.', true);
          return;
        }
        renderGeocodingResults(form, input, results);
        setStatus(form, 'Selecciona una coincidencia. Lórren agrega automáticamente ciudad y país y nunca guardará el primer resultado sin confirmación.');
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
      let timeoutId = null;

      const cleanup = () => {
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        if (timeoutId !== null) window.clearTimeout(timeoutId);
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

      timeoutId = window.setTimeout(
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

    document.addEventListener('keydown', (event) => {
      const input = event.target.closest?.('.attendance-address-search');
      if (!input || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const button = input.closest('.attendance-map-form')?.querySelector('.attendance-search-button');
      if (button && !button.disabled) handleAddressSearch(button);
    }, true);

    function installSearchContext() {
      document.querySelectorAll('.attendance-map-form').forEach((form) => {
        const input = form.querySelector('.attendance-address-search');
        const city = searchCity(form, input);
        if (!input || input.dataset.attendanceContextInstalled === 'true') return;
        input.dataset.attendanceContextInstalled = 'true';
        const note = document.createElement('small');
        note.dataset.attendanceSearchContext = 'true';
        note.className = 'muted';
        note.textContent = city
          ? `Puedes escribir solo la dirección o el lugar; Lórren buscará automáticamente en ${city}, Colombia.`
          : 'Puedes escribir dirección, barrio o nombre del lugar; Lórren agregará Colombia automáticamente.';
        form.querySelector('.attendance-map-actions')?.insertAdjacentElement('afterend', note);
      });
    }

    function refreshMapsInside(element) {
      element?.querySelectorAll?.('.attendance-map').forEach((container) => {
        const map = container.__lorrenAttendanceMap;
        if (map) refreshMapViewport(map);
      });
    }

    function installDetailsRefresh() {
      document.querySelectorAll('[data-map-details], details.attendance-config, [data-attendance-card]').forEach((details) => {
        if (details.dataset.attendanceReliableToggle === 'true') return;
        details.dataset.attendanceReliableToggle = 'true';
        details.addEventListener('toggle', () => {
          if (!details.open) return;
          refreshMapsInside(details);
          window.setTimeout(() => refreshMapsInside(details), 80);
        });
      });
    }

    function refreshAllMaps() {
      document.querySelectorAll('.attendance-map').forEach((container) => {
        const map = container.__lorrenAttendanceMap;
        if (map) refreshMapViewport(map);
      });
    }

    function initialize() {
      installCoordinateDiagnostics();
      installSearchContext();
      installDetailsRefresh();
      refreshAllMaps();
    }

    window.LorrenAttendanceMaps = Object.freeze({ refreshAll: refreshAllMaps, refreshMapViewport });
    window.addEventListener('resize', refreshAllMaps, { passive: true });
    const fallbackCss = document.querySelector('link[data-lorren-leaflet-fallback="true"]');
    fallbackCss?.addEventListener('load', refreshAllMaps, { once: true });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }
  }
})();
