'use strict';

(() => {
  const RUNTIME_FLAG = '__lorrenAttendanceAdminRuntimeCompatibilityLoaded';
  if (window[RUNTIME_FLAG]) return;
  window[RUNTIME_FLAG] = true;

  function compatibilityMaps(root = document) {
    return root.querySelectorAll?.('.attendance-map, .failure-attempt-map') || [];
  }

  function refreshMap(container) {
    const map = container?.__lorrenAttendanceMap || container?.__lorrenFailureMap;
    if (!map?.invalidateSize) return false;
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
