'use strict';

(() => {
  const RUNTIME_FLAG = '__lorrenAttendanceAdminRuntimeCompatibilityLoaded';
  if (window[RUNTIME_FLAG]) return;
  window[RUNTIME_FLAG] = true;

  function finiteCoordinate(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  }

  function coordinate(container, prefix) {
    const latitude = finiteCoordinate(container?.dataset?.[`${prefix}Lat`], -90, 90);
    const longitude = finiteCoordinate(container?.dataset?.[`${prefix}Lng`], -180, 180);
    return latitude === null || longitude === null ? null : [latitude, longitude];
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

  function primaryMark(container) {
    if (container?.classList?.contains('failure-attempt-map')) {
      return coordinate(container, 'failure');
    }
    const mode = String(container?.dataset?.defaultMapMode || '').toLowerCase();
    if (mode === 'departure') return coordinate(container, 'departure');
    if (mode === 'arrival') return coordinate(container, 'arrival');
    if (mode === 'both') return coordinate(container, 'arrival') || coordinate(container, 'departure');
    return coordinate(container, 'arrival') || coordinate(container, 'departure');
  }

  function initialViewport(container) {
    const operation = coordinate(container, 'point');
    const mark = primaryMark(container);
    const anchor = mark || operation;
    if (!anchor) return null;
    if (!operation || !mark) return { center: anchor, zoom: 18 };

    const radius = Math.max(1, Number(container?.dataset?.radius) || 100);
    const distance = haversineMeters(operation, mark);
    const span = Math.max(radius * 2, distance);
    const zoom = span <= 220 ? 18 : span <= 650 ? 17 : span <= 2_000 ? 16 : span <= 8_000 ? 14 : 12;
    return {
      center: [
        (operation[0] + mark[0]) / 2,
        (operation[1] + mark[1]) / 2
      ],
      zoom
    };
  }

  function compatibilityMaps(root = document) {
    return root.querySelectorAll?.('.attendance-map, .failure-attempt-map') || [];
  }

  function refreshMap(container) {
    const map = container?.__lorrenAttendanceMap || container?.__lorrenFailureMap;
    if (!map?.invalidateSize) return false;

    const currentZoom = typeof map.getZoom === 'function' ? Number(map.getZoom()) : Number.NaN;
    if (!Number.isFinite(currentZoom) && typeof map.setView === 'function') {
      const viewport = initialViewport(container);
      if (viewport) map.setView(viewport.center, viewport.zoom, { animate: false });
    }

    map.invalidateSize({ pan: false, debounceMoveend: true });
    return true;
  }

  function refreshMaps(root = document) {
    const canonical = window.LorrenAttendanceMaps;
    if (root === document && typeof canonical?.refreshAll === 'function') {
      canonical.refreshAll();
      return;
    }
    compatibilityMaps(root).forEach((container) => refreshMap(container));
  }

  function scheduleRefresh(root) {
    [0, 80, 260, 700].forEach((delay) => {
      window.setTimeout(() => refreshMaps(root), delay);
    });
  }

  function initialize() {
    scheduleRefresh(document);
    document.querySelectorAll(
      '[data-map-details], [data-failure-map-details], [data-attendance-card]'
    ).forEach((details) => {
      details.addEventListener('toggle', () => {
        if (details.open) scheduleRefresh(details);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();