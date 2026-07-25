'use strict';

(() => {
  const RUNTIME_FLAG = '__lorrenAttendanceAdminRuntimeLoaded';
  if (window[RUNTIME_FLAG]) return;
  window[RUNTIME_FLAG] = true;

  const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const IDECA_TILE_URL = 'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/Mapa_Referencia/mapa_base_3857/MapServer/tile/{z}/{y}/{x}';
  const TILE_TIMEOUT_MS = 5_000;
  const TILE_ERROR_LIMIT = 2;

  const riskTranslations = Object.freeze({
    'ASSIGNMENT NOT ACTIVE': {
      label: 'Asignación no activa',
      help: 'La asignación ya no estaba habilitada para recibir una marcación.'
    },
    'ATTENDANCE NOT ENABLED': {
      label: 'Asistencia no habilitada',
      help: 'El punto operativo no tenía activa la configuración de asistencia.'
    },
    'DUPLICATE ARRIVAL': {
      label: 'Llegada duplicada',
      help: 'Ya existía una marcación de llegada para esta asignación.'
    },
    'ARRIVAL WINDOW NOT OPEN': {
      label: 'Fuera de la ventana de marcación',
      help: 'La marcación se intentó antes de abrir o después de cerrar el horario permitido.'
    },
    'GEOFENCE NOT CONFIGURED': {
      label: 'Geocerca no configurada',
      help: 'El punto no tenía coordenadas y radio suficientes para validar la ubicación.'
    },
    'LOCATION NOT AVAILABLE': {
      label: 'Ubicación no disponible',
      help: 'No se recibió una lectura GPS válida para comparar con el punto operativo.'
    },
    'OUTSIDE GEOFENCE': {
      label: 'Fuera de la geocerca',
      help: 'La ubicación reportada quedó por fuera del radio permitido.'
    },
    'LOW LOCATION ACCURACY': {
      label: 'Precisión GPS insuficiente',
      help: 'El margen de error del GPS superó el máximo configurado para el punto.'
    },
    'UNAUTHORIZED DEVICE': {
      label: 'Dispositivo no autorizado',
      help: 'La marcación no provino del dispositivo activado para el auxiliar.'
    },
    'SHARED DEVICE SIGNAL': {
      label: 'Posible dispositivo compartido',
      help: 'Se detectaron señales compatibles con el uso del mismo dispositivo por más de una persona.'
    },
    'PERSISTENT STORAGE UNAVAILABLE': {
      label: 'Almacenamiento seguro no disponible',
      help: 'El navegador no confirmó almacenamiento persistente para conservar la marca local.'
    },
    'OFFLINE WEB CAPTURE': {
      label: 'Marcación guardada sin conexión',
      help: 'La llegada se conservó primero en el celular y se envió cuando volvió la conexión.'
    },
    'CLIENT CLOCK UNTRUSTED': {
      label: 'Hora del celular no verificable',
      help: 'Al sincronizar después, el servidor no puede certificar por sí solo que la hora local del celular no fue modificada.'
    },
    'DELAYED SYNC': {
      label: 'Sincronización tardía',
      help: 'Pasaron varios minutos entre la captura local y la recepción en Lórren.'
    }
  });

  function normalizedText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function riskLevel(score) {
    if (score >= 80) return 'Crítico';
    if (score >= 50) return 'Alto';
    if (score >= 25) return 'Medio';
    return 'Bajo';
  }

  function translateRiskSignals(root = document) {
    root.querySelectorAll?.('.risk-flag').forEach((element) => {
      if (element.dataset.riskTranslated === 'true') return;
      const original = normalizedText(element.textContent);
      const translation = riskTranslations[original];
      if (!translation) return;
      element.dataset.riskTranslated = 'true';
      element.dataset.riskCode = original.replaceAll(' ', '_');
      element.textContent = translation.label;
      element.title = translation.help;
      element.setAttribute('aria-label', `${translation.label}. ${translation.help}`);
    });

    root.querySelectorAll?.('.risk-score').forEach((element) => {
      if (element.dataset.riskScoreExplained === 'true') return;
      const match = String(element.textContent || '').match(/Riesgo:\s*(\d+)\s*\/\s*100/i);
      if (!match) return;
      const score = Math.max(0, Math.min(100, Number(match[1])));
      element.dataset.riskScoreExplained = 'true';
      element.textContent = `Puntaje de revisión: ${score}/100 · ${riskLevel(score)}`;
      element.title = 'Es un puntaje operativo acumulado por señales que requieren verificación. No representa una probabilidad de fraude.';
      element.setAttribute('aria-label', `${element.textContent}. No es una probabilidad de fraude.`);
    });

    root.querySelectorAll?.('.risk-row').forEach((row) => {
      if (row.dataset.riskExplanationInstalled === 'true') return;
      const hasOfflineCapture = row.querySelector('[data-risk-code="OFFLINE_WEB_CAPTURE"]');
      if (!hasOfflineCapture) return;
      row.dataset.riskExplanationInstalled = 'true';
      const note = document.createElement('div');
      note.className = 'attendance-risk-explanation';
      note.style.cssText = 'flex-basis:100%;margin-top:3px;padding:10px 12px;border:1px solid #f2c66d;border-radius:10px;background:#fff8e7;color:#76520b;font-size:12px;line-height:1.45;';
      note.textContent = 'Este puntaje no significa que la persona esté fuera de la geocerca ni que haya fraude. La marca se guardó primero en el celular y se sincronizó después; por seguridad, la hora local necesita revisión humana. Una fotografía reciente reduce el puntaje, pero no certifica por sí sola la hora del dispositivo.';
      row.appendChild(note);
    });
  }

  function finiteCoordinate(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  }

  function providerStatus(map) {
    const container = map?.getContainer?.();
    if (!container?.parentElement) return null;
    let status = container.parentElement.querySelector('[data-attendance-admin-map-provider]');
    if (status) return status;
    status = document.createElement('div');
    status.dataset.attendanceAdminMapProvider = 'true';
    status.setAttribute('role', 'status');
    status.style.cssText = 'margin-top:7px;color:#64748b;font-size:10px;line-height:1.35;';
    container.insertAdjacentElement('afterend', status);
    return status;
  }

  function tileWarning(map) {
    const container = map?.getContainer?.();
    if (!container?.parentElement) return null;
    let warning = container.parentElement.querySelector('[data-attendance-admin-map-warning]');
    if (warning) return warning;
    warning = document.createElement('div');
    warning.dataset.attendanceAdminMapWarning = 'true';
    warning.hidden = true;
    warning.setAttribute('role', 'alert');
    warning.style.cssText = 'margin-top:8px;padding:10px 12px;border:1px solid #f2c66d;border-radius:10px;background:#fff8e7;color:#76520b;font-size:12px;line-height:1.45;';
    container.insertAdjacentElement('afterend', warning);
    return warning;
  }

  function setMapStatus(map, message, warningMessage = null) {
    const status = providerStatus(map);
    if (status) status.textContent = message;
    const warning = tileWarning(map);
    if (!warning) return;
    warning.hidden = !warningMessage;
    warning.textContent = warningMessage || '';
  }

  function installReliableAdminTiles(leaflet) {
    if (!leaflet?.TileLayer || leaflet.__lorrenAttendanceAdminTilesInstalled) return;
    leaflet.__lorrenAttendanceAdminTilesInstalled = true;
    const previousFactory = leaflet.tileLayer;

    function isAttendanceTileUrl(url) {
      const value = String(url || '');
      return value.includes('tile.openstreetmap.org')
        || value.includes('Mapa_Referencia/mapa_base_3857/MapServer/tile');
    }

    function directLayer(url, options) {
      return new leaflet.TileLayer(url, options);
    }

    function activateProvider(map, state, index) {
      const provider = state.providers[index];
      if (!provider) {
        setMapStatus(
          map,
          'Los fondos cartográficos no respondieron.',
          'No fue posible cargar el fondo del mapa. Las coordenadas, los marcadores y la geocerca siguen disponibles; recarga la página para intentar nuevamente.'
        );
        return null;
      }

      if (state.activeLayer) map.removeLayer(state.activeLayer);
      if (state.timeoutId) window.clearTimeout(state.timeoutId);

      const layer = directLayer(provider.url, {
        ...state.options,
        attribution: provider.attribution,
        maxZoom: Math.max(19, Number(state.options?.maxZoom || 0))
      });
      state.activeLayer = layer;
      state.providerIndex = index;
      let loaded = false;
      let errors = 0;

      const fallback = () => {
        if (state.activeLayer !== layer || loaded) return;
        activateProvider(map, state, index + 1);
      };

      setMapStatus(map, `Cargando fondo cartográfico: ${provider.label}…`);
      layer.once('tileload', () => {
        if (state.activeLayer !== layer) return;
        loaded = true;
        if (state.timeoutId) window.clearTimeout(state.timeoutId);
        setMapStatus(map, `Fondo cartográfico activo: ${provider.label}.`);
      });
      layer.on('tileerror', () => {
        if (state.activeLayer !== layer || loaded) return;
        errors += 1;
        if (errors >= TILE_ERROR_LIMIT) fallback();
      });
      state.timeoutId = window.setTimeout(fallback, TILE_TIMEOUT_MS);
      layer.addTo(map);
      return layer;
    }

    leaflet.tileLayer = function attendanceAdminTileLayer(url, options = {}) {
      if (!isAttendanceTileUrl(url)) return previousFactory.call(this, url, options);
      const placeholder = directLayer(OSM_TILE_URL, options);
      placeholder.addTo = function addReliableAdminLayer(map) {
        if (!map.__lorrenAttendanceAdminTileState) {
          map.__lorrenAttendanceAdminTileState = {
            options,
            providers: [
              {
                label: 'OpenStreetMap',
                url: OSM_TILE_URL,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              },
              {
                label: 'Mapa oficial IDECA · UAECD',
                url: IDECA_TILE_URL,
                attribution: '&copy; IDECA · UAECD'
              }
            ],
            providerIndex: -1,
            activeLayer: null,
            timeoutId: null
          };
          activateProvider(map, map.__lorrenAttendanceAdminTileState, 0);
        }
        return map.__lorrenAttendanceAdminTileState.activeLayer || placeholder;
      };
      return placeholder;
    };
    Object.assign(leaflet.tileLayer, previousFactory);
  }

  function haversineMeters(first, second) {
    const earthRadius = 6_371_000;
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(second[0] - first[0]);
    const longitudeDelta = toRadians(second[1] - first[1]);
    const firstLatitude = toRadians(first[0]);
    const secondLatitude = toRadians(second[0]);
    const value = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * earthRadius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function repairMapViewport(container) {
    const map = container?.__lorrenAttendanceMap;
    if (!map) return false;
    const pointLat = finiteCoordinate(container.dataset.pointLat, -90, 90);
    const pointLng = finiteCoordinate(container.dataset.pointLng, -180, 180);
    if (pointLat === null || pointLng === null) return false;

    const operation = [pointLat, pointLng];
    const markLat = finiteCoordinate(container.dataset.markLat, -90, 90);
    const markLng = finiteCoordinate(container.dataset.markLng, -180, 180);
    const arrival = markLat === null || markLng === null ? null : [markLat, markLng];
    const radius = Math.max(1, Number(container.dataset.radius) || 100);
    const distance = arrival ? haversineMeters(operation, arrival) : 0;
    const span = Math.max(radius * 2, distance);
    const zoom = span <= 220 ? 18 : span <= 650 ? 17 : span <= 2_000 ? 16 : span <= 8_000 ? 14 : 12;
    const center = arrival
      ? [(operation[0] + arrival[0]) / 2, (operation[1] + arrival[1]) / 2]
      : operation;

    map.invalidateSize({ pan: false, debounceMoveend: true });
    map.setView(center, zoom, { animate: false });
    return true;
  }

  function repairMaps(root = document) {
    root.querySelectorAll?.('.attendance-map').forEach((container) => {
      repairMapViewport(container);
    });
  }

  function scheduleMapRepair(root) {
    [0, 80, 260, 700].forEach((delay) => {
      window.setTimeout(() => repairMaps(root), delay);
    });
  }

  function initialize() {
    translateRiskSignals();
    installReliableAdminTiles(window.L);
    scheduleMapRepair(document);

    document.querySelectorAll('[data-map-details], [data-attendance-card]').forEach((details) => {
      details.addEventListener('toggle', () => {
        if (details.open) scheduleMapRepair(details);
      });
    });

    const observer = new MutationObserver(() => translateRiskSignals());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
