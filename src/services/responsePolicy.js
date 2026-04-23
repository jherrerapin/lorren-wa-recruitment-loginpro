const INTENT_VARIANTS = {
  request_cv_pdf_word: [
    'Gracias por enviarlo. Para continuar necesito tu hoja de vida en PDF o Word (.doc/.docx).',
    'Te ayudo con eso: envíame la hoja de vida en PDF o en Word para poder registrarla.',
    'Perfecto, para seguir me falta tu HV en PDF o Word (.doc/.docx).'
  ],
  request_missing_cv: [
    'Gracias. Ese documento no corresponde a la hoja de vida. Por favor envíame tu HV en PDF o Word.',
    'Recibido. Aún me falta tu hoja de vida; compártela en formato PDF o Word, por favor.',
    'Gracias por compartirlo. Para avanzar necesito tu hoja de vida en PDF o Word (.doc/.docx).'
  ],
  attachment_id_doc: [
    'Recibí tu documento de identidad. Ahora envíame tu hoja de vida en PDF o Word para continuar.',
    'Gracias por la cédula. Para seguir con la postulación necesito tu HV en PDF o Word.',
    'Documento de identidad recibido. Me falta la hoja de vida en PDF o Word (.doc/.docx).'
  ],
  attachment_unreadable: [
    'No pude leer bien el archivo. ¿Puedes reenviarlo en PDF o Word (.doc/.docx)?',
    'El archivo llegó ilegible. Por favor vuelve a enviarlo en PDF o Word para revisarlo.',
    'Tu archivo no se pudo procesar correctamente; compártemelo de nuevo en PDF o Word.'
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
    'Excelente, con eso seguimos avanzando en tu registro.',
    '¡Listo! Continuemos con el siguiente paso de tu postulación.'
  ]
};

function normalize(text = '') {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(text = '') {
  return new Set(normalize(text).split(' ').filter(Boolean));
}

function semanticSimilarity(a = '', b = '') {
  const aSet = tokenSet(a);
  const bSet = tokenSet(b);
  if (!aSet.size || !bSet.size) return 0;
  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(aSet.size, bSet.size);
}

function isStrongRepeat(candidateReply, recentOutbound = []) {
  const norm = normalize(candidateReply);
  if (!norm) return false;
  return recentOutbound.some((msg) => semanticSimilarity(norm, msg?.body || '') >= 0.86);
}

export function buildPolicyReply({ replyIntent = 'continue_flow', recentOutbound = [], fallback = '' } = {}) {
  const variants = INTENT_VARIANTS[replyIntent] || [fallback || INTENT_VARIANTS.continue_flow[0]];
  for (const option of variants) {
    if (!isStrongRepeat(option, recentOutbound)) {
      return { text: option, intent: replyIntent };
    }
  }

  const degraded = fallback || variants[0] || INTENT_VARIANTS.continue_flow[0];
  return { text: degraded, intent: replyIntent };
}
