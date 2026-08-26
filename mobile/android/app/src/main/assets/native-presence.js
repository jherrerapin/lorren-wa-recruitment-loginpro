async function handleServiceWorkerMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'CREW_PRESENCE_SYNCED') {
      recordDiagnostic('APP', 'SYNC_CONFIRMED');
      const payload = message.payload || {};
      const serviceRequestId = String(payload.serviceRequestId || selectedServiceRequestId || '').trim();
      const markType = normalizeMarkType(payload.markType) || 'ARRIVAL';
      forgetQueuedMark(serviceRequestId, markType);
      if (serviceRequestId) setMemberServerStatuses(serviceRequestId, markType, payload.memberStatuses);
      if (navigator.onLine) contexts = await loadContexts();
      const context = contexts.find((item) => item.serviceRequestId === serviceRequestId) || currentContext();
      retryNotDetectedCount = pendingAuxiliaryCount(context, markType);
      retryMarkType = retryNotDetectedCount > 0 ? markType : '';
      hasCompletedLeaderScan = retryNotDetectedCount > 0;
      pendingPhoneExceptionWorkerId = '';
      renderPanel();
      setStatus(`${markInfo(markType).title} de cuadrilla confirmada por el servidor. ${payload.message || ''}`.trim(), payload.requiresReview ? 'warning' : '');
      if (retryNotDetectedCount > 0) markRetryAvailable(markType);
      if (navigator.onLine) window.setTimeout(() => window.location.reload(), 500);
      return;
    }
    if (message.type === 'CREW_PRESENCE_SYNC_REJECTED') {
      // CORRECCIÓN: Mostrar el error real del backend en el log
      const backendError = message.payload?.error || message.error || 'SYNC_REJECTED';
      recordDiagnostic('APP', backendError);
      
      const serviceRequestId = String(message.serviceRequestId || message.payload?.serviceRequestId || selectedServiceRequestId || '').trim();
      const queuedMarkType = [...queuedMarkSet(serviceRequestId)].map(normalizeMarkType).find(Boolean) || null;
      const markType = normalizeMarkType(message.payload?.markType)
        || queuedMarkType
        || normalizeMarkType(retryMarkType)
        || 'ARRIVAL';
      forgetQueuedMark(serviceRequestId, markType);
      renderPanel();
      setStatus(`No fue posible registrar la ${markInfo(markType).noun} de la cuadrilla. La marca no quedó confirmada; puedes intentarlo nuevamente.`, 'error');
      return;
    }
    if (message.type === 'CREW_PRESENCE_SYNC_RETRY') {
      if (Number(message.retryAfterMs || 0) > 0) {
        recordDiagnostic('APP', 'SYNC_RETRY_SCHEDULED');
        const markType = normalizeMarkType(retryMarkType) || onlineQueuedMarkType(currentContext()) || 'ARRIVAL';
        setStatus(`La ${markInfo(markType).noun} de cuadrilla sigue enviada pero aún no está confirmada. Lórren la reintentará automáticamente.`, 'warning');
      }
    }
  }
