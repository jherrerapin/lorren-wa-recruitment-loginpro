function normalizeText(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INITIAL_STEPS = new Set(['MENU', 'GREETING_SENT']);
const CONFIRMATION_STEPS = new Set(['CONFIRMING_DATA', 'SCHEDULING', 'SCHEDULED']);

const ACK_ONLY_PATTERNS = [
  /^(ok|okey|okay|dale|listo|entendido)$/,
  /^(gracias|muchas gracias|ok gracias|bien gracias|quedo atento|quedo atenta)$/
];

const GREETING_ONLY_PATTERNS = [
  /^(hola|holi|buenas|buen dia|buenos dias|buena tarde|buenas tardes|buena noche|buenas noches)$/,
  /^(hola|buenas|buenos dias|buenas tardes|buenas noches) (senor|senora|amigo|amiga)$/
];

const GREETING_PREFIX_PATTERN = /^(hola|holi|buenas|buen dia|buenos dias|buena tarde|buenas tardes|buena noche|buenas noches)\b/;

const THANKS_PATTERNS = [/^gracias$/, /^muchas gracias$/, /^ok gracias$/, /^bien gracias$/, /\bte agradezco\b/];
const FAREWELL_PATTERNS = [/\b(chao|adios|hasta luego|nos vemos)\b/];

const NO_INTEREST_PATTERNS = [
  /\bno me interesa\b/,
  /\bya no\b/,
  /\bmejor no\b/,
  /\bprefiero no\b/,
  /\bno deseo continuar\b/,
  /\bno quiero seguir\b/,
  /\bpaso\b/,
  /\bdejemos asi\b/
];

const DEFER_PATTERNS = [
  /\bdespues\b/,
  /\bluego\b/,
  /\bmas tarde\b/,
  /\bahorita no\b/,
  /\ben otro momento\b/,
  /\bluego te escribo\b/
];

const INFO_FIRST_PATTERNS = [
  /\bquiero informacion\b/,
  /\bquiero saber\b/,
  /\bquiero saber primero\b/,
  /\bantes quiero saber\b/,
  /\bprimero quiero saber\b/,
  /\bmas informacion\b/,
  /\binfo\b/,
  /\bcuentame primero\b/
];

const OBJECTION_PATTERNS = [
  /\bprimero dime\b/,
  /\bantes de (?:dar|enviar|compartir) mis datos\b/,
  /\bnecesito saber primero\b/,
  /\bno quiero (?:dar|enviar|compartir) mis datos\b/
];

const ALREADY_SENT_PATTERNS = [
  /\bya envie eso\b/,
  /\bya envie mi hv\b/,
  /\bya envi[eé] eso\b/,
  /\bya mande eso\b/,
  /\bya mand[eé] eso\b/,
  /\bya lo envie\b/,
  /\bya lo envi[eé]\b/,
  /\bya di esos datos\b/,
  /\beso ya lo mande\b/
];

const CHANGE_INTENT_PATTERNS = [
  /\botra vacante\b/,
  /\botro cargo\b/,
  /\bcambie de opinion\b/,
  /\bcambi[eé] de opinion\b/,
  /\bme interesa otra\b/,
  /\bmejor esta otra\b/,
  /\bquiero otra vacante\b/
];

const CV_PATTERNS = [/\bhoja de vida\b/, /\bhv\b/, /\bcv\b/, /\bcurriculum\b/, /\bcurriculo\b/];

const YES_CONFIRMATION_PATTERNS = [
  /^(si|sii|sí|correcto|correcta|de acuerdo|confirmo|listo|perfecto)$/,
  /\b(esta bien|todo correcto|todo bien|todo esta correcto)\b/
];

const CORRECTION_PATTERNS = [
  /^no$/,
  /^no[,\s]+/,
  /\b(correccion|corrijo|me equivoque|equivocado|no es|cambiar|cambio|eso esta mal|quise decir|en realidad|mas bien)\b/
];

const APPLY_PATTERNS = [/\b(aplicar|postular|continuar|me interesa|quiero seguir|deseo continuar)\b/];
const FAQ_PATTERNS = [/\b(que hacen|como funciona|cuando|cuanto|donde|requisito|salario|pago|horario|entrevista|ubicacion|condiciones)\b/];
const DATA_PATTERNS = [
  /\b(edad|cc|cedula|cedula de ciudadania|ti|ce|ppt|barrio|experiencia|restricciones|moto|bicicleta|transporte|nombre|localidad)\b/,
  /\b\d{5,}\b/
];

function matchesAny(patterns = [], normalized = '') {
  return patterns.some((pattern) => pattern.test(normalized));
}

function normalizeStep(options = {}) {
  return String(options.currentStep || options.step || '').trim().toUpperCase() || null;
}

function isInitialConversation(options = {}) {
  const step = normalizeStep(options);
  if (!step) return Boolean(options.isInitialContact);
  return INITIAL_STEPS.has(step);
}

function isConfirmationContext(options = {}) {
  const step = normalizeStep(options);
  return Boolean(step && CONFIRMATION_STEPS.has(step));
}

function hasDataSignal(normalized = '') {
  return matchesAny(DATA_PATTERNS, normalized);
}

function hasNonGreetingContent(normalized = '') {
  if (!GREETING_PREFIX_PATTERN.test(normalized)) return Boolean(normalized);
  const withoutGreeting = normalized.replace(GREETING_PREFIX_PATTERN, '').trim();
  return Boolean(withoutGreeting);
}

export function detectConversationIntent(text = '', options = {}) {
  const normalized = normalizeText(text);
  const hasUnsupportedMedia = Boolean(options.hasUnsupportedMedia);

  if (hasUnsupportedMedia) return 'unsupported_file_or_message';
  if (!normalized) return 'unsupported_file_or_message';

  const initialConversation = isInitialConversation(options);
  const doneStep = Boolean(options.isDoneStep || normalizeStep(options) === 'DONE');
  const confirmationContext = isConfirmationContext(options);
  const pureGreeting = matchesAny(GREETING_ONLY_PATTERNS, normalized);
  const greetingPrefix = GREETING_PREFIX_PATTERN.test(normalized);
  const containsData = hasDataSignal(normalized);

  if (matchesAny(NO_INTEREST_PATTERNS, normalized)) return 'no_interest';
  if (matchesAny(DEFER_PATTERNS, normalized)) return 'defer_intent';
  if (matchesAny(OBJECTION_PATTERNS, normalized)) return 'objection';
  if (matchesAny(ALREADY_SENT_PATTERNS, normalized)) return 'already_sent';
  if (matchesAny(CHANGE_INTENT_PATTERNS, normalized)) return 'change_intent';

  if (pureGreeting) {
    if (initialConversation) return 'greeting';
    return doneStep ? 'post_completion_ack' : 'provide_data';
  }

  if (greetingPrefix && hasNonGreetingContent(normalized)) {
    // El saludo es cortesía dentro de un mensaje con contenido; no debe reiniciar el flujo.
  } else if (matchesAny(THANKS_PATTERNS, normalized)) {
    return doneStep ? 'post_completion_ack' : 'thanks';
  } else if (matchesAny(FAREWELL_PATTERNS, normalized)) {
    return 'farewell';
  }

  if (matchesAny(INFO_FIRST_PATTERNS, normalized)) return 'info_request';
  if (matchesAny(CV_PATTERNS, normalized)) return 'cv_intent';

  if (matchesAny(CORRECTION_PATTERNS, normalized)) return 'confirmation_no_or_correction';

  if (matchesAny(YES_CONFIRMATION_PATTERNS, normalized)) {
    if (containsData && !confirmationContext) return 'provide_data';
    return 'confirmation_yes';
  }

  if (matchesAny(APPLY_PATTERNS, normalized)) return 'apply_intent';
  if (matchesAny(FAQ_PATTERNS, normalized)) return 'faq';
  if (containsData) return 'provide_data';
  if (/\b(pero|aunque|en realidad|mejor|mas bien)\b/.test(normalized)) return 'provide_correction';

  if (doneStep && matchesAny(ACK_ONLY_PATTERNS, normalized)) return 'post_completion_ack';

  return 'provide_data';
}

export function isPostCompletionAck(text = '') {
  const normalized = normalizeText(text);
  return matchesAny(ACK_ONLY_PATTERNS, normalized);
}
