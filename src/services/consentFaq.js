function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildConsentQuestionReply(text = '') {
  const raw = String(text || '').trim();
  const normalized = normalize(raw);
  const asksQuestion = raw.includes('?') || /\b(que|como|para que|quien|pueden|puede|obligatorio|autorizar|autorizacion|datos|privacidad|revocar|eliminar|corregir)\b/.test(normalized);
  if (!normalized || !asksQuestion) return '';

  if (/\b(para que|uso|usar|usan|utilizan|tratar|tratamiento|procesar|guardar|mis datos)\b/.test(normalized)) {
    return 'Tus datos y tu hoja de vida se usarán para gestionar la postulación, validar la información, contactarte y conservar la trazabilidad del proceso de selección.';
  }

  if (/\b(quien|empresa|loginpro|tercero|compartir|comparten)\b/.test(normalized)) {
    return 'La autorización es para que LoginPro gestione tu información dentro del proceso de selección y pueda contactarte sobre la postulación.';
  }

  if (/\b(revocar|revocatoria|retirar|eliminar|borrar|corregir|actualizar|consultar)\b/.test(normalized)) {
    return 'Puedes solicitar la consulta, actualización, corrección o revocatoria de la autorización sobre tus datos.';
  }

  if (/\b(obligatorio|necesario|que pasa si no|si no autorizo|no quiero autorizar)\b/.test(normalized)) {
    return 'La autorización es necesaria para gestionar esta postulación por WhatsApp. Si no autorizas, no continuaremos procesando tus datos por este medio.';
  }

  return '';
}
