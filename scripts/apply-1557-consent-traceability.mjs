import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/dataConsentGate.js';
let source = readFileSync(file, 'utf8');

function replaceOnce(input, before, after, label) {
  const count = input.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  return input.replace(before, after);
}

source = replaceOnce(
  source,
`function redactedConsentEvidenceBody(decision = '') {
  if (decision === 'ACCEPTED') return '[CONSENT_ACCEPTED]';
  if (decision === 'REVOKED') return '[CONSENT_REVOKED]';
  return '[REDACTED_PRECONSENT]';
}`,
`const PRE_CONSENT_DATA_EVIDENCE_BODY = 'Mensaje con datos personales enviado antes de autorizar; el contenido no fue almacenado.';
const PRE_CONSENT_ATTACHMENT_EVIDENCE_BODY = 'Archivo enviado antes de autorizar; el archivo no fue almacenado.';
const PRE_CONSENT_PROTECTED_EVIDENCE_BODY = 'Mensaje recibido antes de completar la autorización; el contenido protegido no fue almacenado.';

function consentEvidenceBody(decision = '', body = '', message = {}) {
  const literalBody = String(body || '').trim().slice(0, 4096);

  // La decisión de consentimiento ya es evidencia autorizante/revocatoria y debe
  // verse en la conversación tal como la expresó el candidato.
  if (['ACCEPTED', 'REVOKED'].includes(decision) && literalBody) return literalBody;

  // Archivos y datos personales recibidos antes del consentimiento nunca se
  // reconstruyen ni se persisten literalmente solo para mejorar la trazabilidad.
  if (isProtectedAttachment(message) || /ATTACHMENT/i.test(decision)) {
    return PRE_CONSENT_ATTACHMENT_EVIDENCE_BODY;
  }
  const profileData = literalBody
    ? evaluateProfileDataEvidence(literalBody).containsProfileData
    : false;
  if (/profile_data_before_consent/i.test(decision) || profileData) {
    return PRE_CONSENT_DATA_EVIDENCE_BODY;
  }

  // Los turnos no sensibles que disparan o aclaran el consentimiento sí pueden
  // conservar el lenguaje real del candidato en lugar de una etiqueta interna.
  if (literalBody) return literalBody;
  return PRE_CONSENT_PROTECTED_EVIDENCE_BODY;
}`,
  'replace consent evidence body policy'
);

source = replaceOnce(
  source,
  '    body: redactedConsentEvidenceBody(decision),',
  '    body: consentEvidenceBody(decision, body, message),',
  'use consent evidence body in saveInboundConsentEvidence'
);

source = replaceOnce(
  source,
  "        body: '[REDACTED_PRECONSENT]',",
  '        body: consentEvidenceBody(decision, inboundText(message), message),',
  'replace technical preconsent placeholder in claim'
);

writeFileSync(file, source);
