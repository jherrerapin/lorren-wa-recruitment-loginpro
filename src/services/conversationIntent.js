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

export function detectConversationIntent(text = '', options = {}) {
  const normalized = normalizeText(text);
  const hasUnsupportedMedia = Boolean(options.hasUnsupportedMedia);

  if (hasUnsupportedMedia) return 'unsupported_file_or_message';
  if (!normalized) return 'unsupported_file_or_message';

  if (/(hola|buenas|buen dia|buenas tardes|buenas noches)/.test(normalized)) return 'greeting';
  if (/(gracias|te agradezco|muchas gracias)/.test(normalized)) return options.isDoneStep ? 'post_completion_ack' : 'thanks';
  if (/(chao|adios|hasta luego|nos vemos)/.test(normalized)) return 'farewell';
  if (/(hoja de vida|\bcv\b|curriculum)/.test(normalized)) return 'cv_intent';
  if (/(si|correcto|esta bien|todo correcto|confirmo|de acuerdo|todo esta correcto)/.test(normalized)) return 'confirmation_yes';
  if (/(no|correccion|corrijo|me equivoque|equivocado|no es|cambiar|cambio)/.test(normalized)) return 'confirmation_no_or_correction';
  if (/(aplicar|postular|continuar|me interesa|quiero seguir|deseo continuar)/.test(normalized)) return 'apply_intent';
  if (/(que hacen|como funciona|cuando|donde|requisito|salario|pago|horario|entrevista)/.test(normalized)) return 'faq';
  if (/(edad|cc|cedula|ti|ce|ppt|barrio|experiencia|restricciones|moto|bicicleta|transporte|nombre)/.test(normalized) || /\d{5,}/.test(normalized)) return 'provide_data';
  if (/(pero|aunque|en realidad|mejor|mas bien)/.test(normalized)) return 'provide_correction';

  if (options.isDoneStep && ACK_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return 'post_completion_ack';

  return 'provide_data';
}

export function isPostCompletionAck(text = '') {
  const normalized = normalizeText(text);
  return ACK_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}
