function normalizeText(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ACK_ONLY_PATTERNS = [
  /^(ok|okey|okay|dale|listo|entendido)$/,
  /^(gracias|muchas gracias|ok gracias|bien gracias|quedo atento|quedo atenta)$/
];

const NO_INTEREST_PATTERNS = [
  /\bno me interesa\b/,
  /\bya no\b/,
  /\bmejor no\b/,
  /\bprefiero no\b/,
  /\bno deseo continuar\b/,
  /\bpaso\b/
];

const DEFER_PATTERNS = [
  /\bdespues\b/,
  /\bluego\b/,
  /\bmas tarde\b/,
  /\bahorita no\b/,
  /\ben otro momento\b/
];

const INFO_FIRST_PATTERNS = [
  /\bquiero informacion\b/,
  /\bquiero saber\b/,
  /\bquiero saber primero\b/,
  /\bantes quiero saber\b/,
  /\bprimero quiero saber\b/,
  /\bmas informacion\b/,
  /\binformacion\b/,
  /\binfo\b/
];

const OBJECTION_PATTERNS = [
  /\bno te voy a dar mis datos\b/,
  /\bno voy a dar mis datos\b/,
  /\bprimero dime\b/,
  /\bantes de darte mis datos\b/,
  /\bantes de enviar mis datos\b/,
  /\bno quiero dar mis datos\b/
];

const ALREADY_SENT_PATTERNS = [
  /\bya envie eso\b/,
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
  /\bcambi[eé] de opini[oó]n\b/,
  /\bme interesa otra\b/,
  /\bmejor esta otra\b/
];

export function detectConversationIntent(text = '', options = {}) {
  const normalized = normalizeText(text);
  const hasUnsupportedMedia = Boolean(options.hasUnsupportedMedia);

  if (hasUnsupportedMedia) return 'unsupported_file_or_message';
  if (!normalized) return 'unsupported_file_or_message';

  if (/(hola|buenas|buen dia|buenas tardes|buenas noches)/.test(normalized)) return 'greeting';
  if (/(gracias|te agradezco|muchas gracias)/.test(normalized)) return options.isDoneStep ? 'post_completion_ack' : 'thanks';
  if (/(chao|adios|hasta luego|nos vemos)/.test(normalized)) return 'farewell';
  if (NO_INTEREST_PATTERNS.some((pattern) => pattern.test(normalized))) return 'no_interest';
  if (DEFER_PATTERNS.some((pattern) => pattern.test(normalized))) return 'defer_intent';
  if (OBJECTION_PATTERNS.some((pattern) => pattern.test(normalized))) return 'objection';
  if (INFO_FIRST_PATTERNS.some((pattern) => pattern.test(normalized))) return 'info_request';
  if (ALREADY_SENT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'already_sent';
  if (CHANGE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'change_intent';
  if (/(hoja de vida|\bcv\b|curriculum)/.test(normalized)) return 'cv_intent';
  if (/(si|correcto|esta bien|todo correcto|todo bien|confirmo|de acuerdo|todo esta correcto|perfecto)/.test(normalized)) return 'confirmation_yes';
  if (/(no|correccion|corrijo|me equivoque|equivocado|no es|cambiar|cambio|eso esta mal)/.test(normalized)) return 'confirmation_no_or_correction';
  if (/(aplicar|postular|continuar|me interesa|quiero seguir|deseo continuar)/.test(normalized)) return 'apply_intent';
  if (/(que hacen|como funciona|cuando|donde|requisito|salario|pago|horario|entrevista|ubicacion|condiciones)/.test(normalized)) return 'faq';
  if (/(edad|cc|cedula|ti|ce|ppt|barrio|experiencia|restricciones|moto|bicicleta|transporte|nombre|localidad)/.test(normalized) || /\d{5,}/.test(normalized)) return 'provide_data';
  if (/(pero|aunque|en realidad|mejor|mas bien)/.test(normalized)) return 'provide_correction';

  if (options.isDoneStep && ACK_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return 'post_completion_ack';

  return 'provide_data';
}

export function isPostCompletionAck(text = '') {
  const normalized = normalizeText(text);
  return ACK_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}
