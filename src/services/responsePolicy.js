import { ReplySimilarityThreshold, isSubstantiallySimilarReply, normalizeReplySignature } from './replySimilarityPolicy.js';

const INTENT_VARIANTS = {
  request_cv_pdf_word: [
    'Gracias por enviarlo. Para continuar necesito tu hoja de vida en PDF o DOCX.',
    'Te ayudo con eso: envíame la hoja de vida en PDF o en DOCX para poder registrarla.',
    'Perfecto, para seguir me falta tu HV en PDF o DOCX.'
  ],
  request_missing_cv: [
    'Gracias. Ese documento no corresponde a la hoja de vida. Por favor envíame tu HV en PDF o DOCX.',
    'Recibido. Aún me falta tu hoja de vida; compártela en formato PDF o DOCX, por favor.',
    'Gracias por compartirlo. Para avanzar necesito tu hoja de vida en PDF o DOCX.'
  ],
  attachment_id_doc: [
    'Recibí tu documento de identidad. Ahora envíame tu hoja de vida en PDF o DOCX para continuar.',
    'Gracias por la cédula. Para seguir con la postulación necesito tu HV en PDF o DOCX.',
    'Documento de identidad recibido. Me falta la hoja de vida en PDF o DOCX.'
  ],
  attachment_unreadable: [
    'No pude leer bien el archivo. ¿Puedes reenviarlo en PDF o DOCX?',
    'El archivo llegó ilegible. Por favor vuelve a enviarlo en PDF o DOCX para revisarlo.',
    'Tu archivo no se pudo procesar correctamente; compártemelo de nuevo en PDF o DOCX.'
  ],
  answer_question_then_continue: [
    'Claro, te confirmo eso. Si te parece, después continuamos con el dato pendiente.',
    'Buena pregunta; ya te respondo. Enseguida retomamos tu registro para avanzar.',
    'Te explico eso primero y luego seguimos con tu postulación, ¿de acuerdo?'
  ],
  confirm_correction: [
    'Listo, corrección aplicada. Continuemos con el siguiente dato.',
    'Perfecto, ya actualicé esa información. Seguimos con tu proceso.',
    'Gracias por la corrección, ya quedó registrada. Avancemos.'
  ],
  continue_flow: [
    'Perfecto, gracias. Continúo con tu postulación y te pido el siguiente dato enseguida.',
    'Gracias, eso ayuda a avanzar con tu registro.',
    'Listo, seguimos con lo puntual que falta para tu postulación.'
  ],
  request_missing_data: [
    'Para continuar necesito este dato pendiente. En cuanto me lo compartas, seguimos.',
    'Vamos bien; compárteme ese dato puntual y seguimos.',
    'Gracias. Compárteme ese dato faltante y continúo de inmediato con tu proceso.'
  ]
};

function normalize(text = '') {
  return normalizeReplySignature(text);
}

function isStrongRepeat(candidateReply, recentOutbound = []) {
  const norm = normalize(candidateReply);
  if (!norm) return false;
  return recentOutbound.some((msg) => isSubstantiallySimilarReply(candidateReply, msg?.body || '', {
    threshold: ReplySimilarityThreshold.RESPONSE_POLICY
  }));
}

function buildContextSuffix(contextSummary = '') {
  const normalized = normalize(contextSummary);
  if (!normalized) return '';
  if (normalized.includes('pregunta')) return ' Te respondo eso primero.';
  if (normalized.includes('adjunto') || normalized.includes('archivo')) return ' Recibí el adjunto que enviaste.';
  return '';
}

export function buildPolicyReply({ replyIntent = 'continue_flow', recentOutbound = [], fallback = '', contextSummary = '' } = {}) {
  const variants = INTENT_VARIANTS[replyIntent] || [fallback || INTENT_VARIANTS.continue_flow[0]];
  for (const option of variants) {
    if (!isStrongRepeat(option, recentOutbound)) {
      return { text: `${option}${buildContextSuffix(contextSummary)}`.trim(), intent: replyIntent };
    }
  }

  const degraded = fallback || variants[0] || INTENT_VARIANTS.continue_flow[0];
  return { text: `${degraded}${buildContextSuffix(contextSummary)}`.trim(), intent: replyIntent };
}
