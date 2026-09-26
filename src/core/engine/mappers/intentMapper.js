const CANONICAL_INTENTS = new Set([
  'GREETING',
  'HELLO',
  'THANKS',
  'ACKNOWLEDGEMENT',
  'FAREWELL',
  'END_CONVERSATION',
  'CANCEL_APPLICATION',
  'STOP_APPLICATION',
  'DECLINE_PROCESS',
  'DEFER_PROCESS',
  'OBJECTION',
  'APPLY_INTENT',
  'PROVIDE_DATA',
  'CHANGE_VACANCY',
  'CV_INTENT',
  'UNSUPPORTED_INPUT',
  'ACCEPT_DATA_CONSENT',
  'REJECT_DATA_CONSENT',
  'CONSENT_ACCEPTED',
  'CONSENT_REJECTED',
  'DATA_CONSENT_ACCEPTED',
  'DATA_CONSENT_REJECTED',
  'ASK_VACANCY_INFORMATION',
  'ASK_VACANCY_COMPANY',
  'ASK_VACANCY_SALARY',
  'ASK_VACANCY_CONDITIONS',
  'ASK_VACANCY_REQUIREMENTS',
  'ASK_VACANCY_EXPERIENCE',
  'ASK_VACANCY_AGE',
  'ASK_VACANCY_FUNCTIONS',
  'ASK_VACANCY_LOCATION',
  'ASK_VACANCY_SCHEDULE',
  'SCHEDULE_INTERVIEW',
  'BOOK_INTERVIEW',
  'ACCEPT_INTERVIEW_SLOT',
  'RESERVE_SLOT',
  'RESCHEDULE_INTERVIEW',
  'REQUEST_RESCHEDULE',
  'CANCEL_INTERVIEW',
  'CANCEL_BOOKING',
  'CANCEL_ATTENDANCE',
  'CONFIRM_ATTENDANCE'
]);

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedLegacyIntent(value = '') {
  return normalize(value).replace(/\s+/g, '_');
}

function isQuestionLike(text = '') {
  const raw = String(text || '');
  const normalized = normalize(raw);
  return /[?¿]/.test(raw)
    || /\b(cual|cuales|cuanto|cuantos|cuando|donde|como|quien|que|por que)\b/.test(normalized);
}

function mapConsentIntent(text = '') {
  const normalized = normalize(text);
  if (!normalized) return null;

  if (/\b(no autorizo|no consiento|no doy consentimiento|no doy mi consentimiento|no acepto|rechazo el tratamiento|revoco(?: mi)? autorizacion|revoco(?: mi)? consentimiento)\b/.test(normalized)) {
    return 'REJECT_DATA_CONSENT';
  }

  if (/\b(autorizo|consiento|doy mi consentimiento|doy consentimiento|doy permiso|acepto el tratamiento|estoy de acuerdo)\b/.test(normalized)) {
    return 'ACCEPT_DATA_CONSENT';
  }

  return null;
}

function mapInterviewIntent(text = '') {
  const normalized = normalize(text);
  if (!normalized) return null;

  const hasInterviewTopic = /\b(entrevista|cita)\b/.test(normalized);

  if (
    /\b(reagendar|reagendo|reprogramar|reprogramo|aplazar|posponer|mover|cambiar)\b/.test(normalized)
    && /\b(entrevista|cita|fecha|hora|horario)\b/.test(normalized)
  ) {
    return 'RESCHEDULE_INTERVIEW';
  }

  if (
    /\b(cancelar|cancelo|cancelacion|ya no voy|no voy|no podre asistir|no puedo asistir)\b/.test(normalized)
    && hasInterviewTopic
  ) {
    return 'CANCEL_INTERVIEW';
  }

  if (
    hasInterviewTopic
    && (
      /\b(agendar|agendo|programar|programo|reservar|reservo|separar)\b/.test(normalized)
      || /\b(horarios?|fechas?) disponibles?\b/.test(normalized)
      || /\bcuando puedo (?:ir|asistir|presentarme)\b/.test(normalized)
    )
  ) {
    return 'SCHEDULE_INTERVIEW';
  }

  return null;
}

function mapVacancyQuestionIntent(text = '') {
  const normalized = normalize(text);
  if (!normalized) return 'ASK_VACANCY_INFORMATION';

  if (/\b(empresa|compania|cliente|loginpro|operacion)\b/.test(normalized)) {
    return 'ASK_VACANCY_COMPANY';
  }

  if (/\b(salario|sueldo|pago|cuanto pagan|cuanto es)\b/.test(normalized)) {
    return 'ASK_VACANCY_SALARY';
  }

  if (/\b(contrato|prestacion|beneficio|beneficios|condicion|condiciones)\b/.test(normalized)) {
    return 'ASK_VACANCY_CONDITIONS';
  }

  if (/\b(edad|rango de edad)\b/.test(normalized)) {
    return 'ASK_VACANCY_AGE';
  }

  if (/\b(experiencia|tiempo de experiencia)\b/.test(normalized)) {
    return 'ASK_VACANCY_EXPERIENCE';
  }

  if (/\b(funcion|funciones|labor|labores|tarea|tareas|responsabilidad|responsabilidades|que hace|en que consiste)\b/.test(normalized)) {
    return 'ASK_VACANCY_FUNCTIONS';
  }

  if (/\b(donde|direccion|ubicacion|zona|sector|lugar de trabajo|queda)\b/.test(normalized)) {
    return 'ASK_VACANCY_LOCATION';
  }

  if (/\b(horario|horarios|turno|turnos|jornada)\b/.test(normalized)) {
    return 'ASK_VACANCY_SCHEDULE';
  }

  if (/\b(requisito|requisitos|perfil|estudio|formacion|documento|documentos|moto|carro|transporte|vehiculo)\b/.test(normalized)) {
    return 'ASK_VACANCY_REQUIREMENTS';
  }

  return 'ASK_VACANCY_INFORMATION';
}

function hasVacancyQuestionSignal(text = '') {
  const normalized = normalize(text);
  if (!isQuestionLike(text)) return false;

  return /\b(vacante|oferta|convocatoria|cargo|trabajo|funcion|funciones|requisito|requisitos|salario|sueldo|pago|horario|turno|ubicacion|direccion|zona|condiciones|contrato|beneficio|experiencia|edad|empresa|compania|cliente|operacion)\b/.test(normalized);
}

function hasApplicationSignal(text = '') {
  const normalized = normalize(text);
  return /\b(aplicar|postular|postularme|me interesa|interesado|interesada|quiero seguir|deseo continuar|quiero trabajar|vacante|cargo|auxiliar|operario|lider)\b/.test(normalized);
}

/**
 * Pure compatibility mapper between the current NLU vocabulary and the
 * canonical intents consumed by Functional Core policies.
 *
 * It performs no classification I/O. Text inspection is deliberately limited
 * to deterministic disambiguation that was previously scattered across the
 * webhook (consent, interview lifecycle and vacancy FAQ domains).
 */
export function mapLegacyIntentToCanonical(legacyIntent = null, text = '') {
  const rawIntent = String(legacyIntent || '').trim();
  const upperIntent = rawIntent.toUpperCase();

  if (CANONICAL_INTENTS.has(upperIntent)) {
    return upperIntent;
  }

  const consentIntent = mapConsentIntent(text);
  if (consentIntent) return consentIntent;

  const interviewIntent = mapInterviewIntent(text);
  if (interviewIntent) return interviewIntent;

  const legacy = normalizedLegacyIntent(rawIntent);

  if (
    ['faq', 'info_request', 'ask_question'].includes(legacy)
    || hasVacancyQuestionSignal(text)
  ) {
    return mapVacancyQuestionIntent(text);
  }

  switch (legacy) {
    case 'greeting':
      return hasApplicationSignal(text) ? 'APPLY_INTENT' : 'GREETING';
    case 'apply_intent':
      return 'APPLY_INTENT';
    case 'provide_data':
    case 'provide_correction':
    case 'confirmation_no_or_correction':
      return 'PROVIDE_DATA';
    case 'confirmation_yes':
      return 'ACKNOWLEDGEMENT';
    case 'thanks':
      return 'THANKS';
    case 'post_completion_ack':
    case 'already_sent':
      return 'ACKNOWLEDGEMENT';
    case 'farewell':
      return 'FAREWELL';
    case 'no_interest':
      return 'DECLINE_PROCESS';
    case 'defer_intent':
      return 'DEFER_PROCESS';
    case 'objection':
      return 'OBJECTION';
    case 'change_intent':
      return 'CHANGE_VACANCY';
    case 'cv_intent':
      return 'CV_INTENT';
    case 'unsupported_file_or_message':
      return 'UNSUPPORTED_INPUT';
    case 'schedule_interview':
    case 'book_interview':
      return 'SCHEDULE_INTERVIEW';
    case 'reschedule_interview':
      return 'RESCHEDULE_INTERVIEW';
    case 'cancel_interview':
      return 'CANCEL_INTERVIEW';
    case 'confirm_attendance':
      return 'CONFIRM_ATTENDANCE';
    default:
      return rawIntent ? upperIntent : null;
  }
}

export default mapLegacyIntentToCanonical;
