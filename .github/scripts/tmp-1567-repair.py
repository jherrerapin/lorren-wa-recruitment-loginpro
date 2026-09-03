from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, got {count}')
    p.write_text(text.replace(old, new, 1))


gate = 'src/services/dataConsentGate.js'
replace_once(gate, """function isContextualInterestConfirmationMode(mode = '') {
  const value = String(mode || '');
  return value === APPLICATION_INTEREST_PENDING_MODE
    || value === PRE_CONSENT_CV_RESEND_MODE
    || PRE_CONSENT_OFFER_TO_CAPTURE_MODE.has(value)
    || isPreConsentCaptureMode(value)
    || parseAlternativeMode(value).active;
}

export function shouldRequestConsentForTurn(candidate = {}, text = '') {
  const mode = String(candidate?.botResumeMode || '');
  const turn = analyzeConversationTurn(text, { currentStep: candidate?.currentStep });
  const explicitInterest = Boolean(
    turn.interest
    || (turn.confirmation && isContextualInterestConfirmationMode(mode))
  );
  const captureAlreadyAuthorized = isPreConsentCaptureMode(mode);
  const alternativePending = parseAlternativeMode(mode).active;
  const futureProfilePending = PRE_CONSENT_OFFER_TO_CAPTURE_MODE.has(mode);
  const activeVacancyReady = Boolean(
    candidate?.vacancyId
    && !isAwaitingCampaignVacancyConfirmation(candidate)
  );

  return {
    allowed: captureAlreadyAuthorized
      || ((activeVacancyReady || alternativePending || futureProfilePending) && explicitInterest),
    explicitInterest,
    turn,
    mode
  };
}
""", """function isContextualInterestConfirmationMode(mode = '') {
  const value = String(mode || '');
  return value === APPLICATION_INTEREST_PENDING_MODE
    || value === PRE_CONSENT_CV_RESEND_MODE
    || PRE_CONSENT_OFFER_TO_CAPTURE_MODE.has(value)
    || isPreConsentCaptureMode(value)
    || parseAlternativeMode(value).active;
}

function isShortAffirmativeTurn(text = '') {
  const value = normalize(text);
  return /^(?:s+i+|sip|claro|correcto|exacto|de acuerdo|dale|ok|listo)$/.test(value);
}

export function shouldRequestConsentForTurn(candidate = {}, text = '') {
  const mode = String(candidate?.botResumeMode || '');
  const turn = analyzeConversationTurn(text, { currentStep: candidate?.currentStep });
  const captureAlreadyAuthorized = isPreConsentCaptureMode(mode);
  const alternativePending = parseAlternativeMode(mode).active;
  const futureProfilePending = PRE_CONSENT_OFFER_TO_CAPTURE_MODE.has(mode);
  const activeVacancyReady = Boolean(
    candidate?.vacancyId
    && !isAwaitingCampaignVacancyConfirmation(candidate)
  );
  const contextualShortInterest = Boolean(
    activeVacancyReady
    && isShortAffirmativeTurn(text)
    && (
      isContextualInterestConfirmationMode(mode)
      || PROTECTED_STEPS.has(candidate?.currentStep)
    )
  );
  const explicitInterest = Boolean(
    turn.interest
    || (turn.confirmation && isContextualInterestConfirmationMode(mode))
    || contextualShortInterest
  );

  return {
    allowed: captureAlreadyAuthorized
      || ((activeVacancyReady || alternativePending || futureProfilePending) && explicitInterest),
    explicitInterest,
    turn,
    mode
  };
}
""")

replace_once(gate, """  if (parseConsentPendingMode(candidate?.botResumeMode).pending) return { block: true, reason: 'consent_pending' };
  if (isPreConsentCaptureMode(candidate?.botResumeMode)) return { block: true, reason: 'capture_mode_without_consent' };
  if (isProtectedAttachment(message)) return { block: true, reason: 'attachment_before_consent' };
  if (PROTECTED_STEPS.has(candidate?.currentStep)) return { block: true, reason: 'protected_step_without_consent' };
  const profileDataDecision = options.profileDataDecision || evaluateProfileDataEvidence(body, { candidate });
  if (profileDataDecision.containsProfileData) return { block: true, reason: 'profile_data_before_consent' };
  if (shouldRequestConsentForTurn(candidate, body).allowed) {
    return { block: true, reason: 'candidate_wants_to_continue' };
  }
  return { block: false, reason: 'consent_not_required_for_this_turn' };
""", """  if (parseConsentPendingMode(candidate?.botResumeMode).pending) return { block: true, reason: 'consent_pending' };
  if (isPreConsentCaptureMode(candidate?.botResumeMode)) return { block: true, reason: 'capture_mode_without_consent' };
  if (isProtectedAttachment(message)) return { block: true, reason: 'attachment_before_consent' };
  if (PROTECTED_STEPS.has(candidate?.currentStep)) {
    if (shouldRequestConsentForTurn(candidate, body).allowed) {
      return { block: true, reason: 'candidate_wants_to_continue' };
    }
    return { block: true, reason: 'protected_step_without_consent' };
  }
  const profileDataDecision = options.profileDataDecision || evaluateProfileDataEvidence(body, { candidate });
  if (profileDataDecision.containsProfileData) return { block: true, reason: 'profile_data_before_consent' };
  if (shouldRequestConsentForTurn(candidate, body).allowed) {
    return { block: true, reason: 'candidate_wants_to_continue' };
  }
  if (
    String(candidate?.botResumeMode || '') === APPLICATION_INTEREST_PENDING_MODE
    && !isQuestionLike(body)
  ) {
    return { block: true, reason: 'application_interest_pending' };
  }
  return { block: false, reason: 'consent_not_required_for_this_turn' };
""")

replace_once(gate, """const PRE_CONSENT_DATA_EVIDENCE_BODY = 'Mensaje con datos personales enviado antes de autorizar; el contenido no fue almacenado.';
const PRE_CONSENT_ATTACHMENT_EVIDENCE_BODY = 'Archivo enviado antes de autorizar; el archivo no fue almacenado.';
""", """const PRE_CONSENT_ATTACHMENT_EVIDENCE_BODY = 'Archivo enviado antes de autorizar; el archivo no fue almacenado.';
""")

replace_once(gate, """  // Archivos y datos personales recibidos antes del consentimiento nunca se
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
}
""", """  // Los archivos siguen sin descargarse ni persistirse antes del consentimiento.
  if (isProtectedAttachment(message) || /ATTACHMENT/i.test(decision)) {
    return PRE_CONSENT_ATTACHMENT_EVIDENCE_BODY;
  }

  // El texto inbound se conserva literalmente como trazabilidad conversacional.
  // Esto no lo convierte en dato de perfil ni autoriza su extracción posterior.
  if (literalBody) return literalBody;
  return PRE_CONSENT_PROTECTED_EVIDENCE_BODY;
}

function isPreConsentProtectedTextEvidence(decision = '', body = '', message = {}) {
  if (isProtectedAttachment(message) || /ATTACHMENT/i.test(decision)) return false;
  if (['ACCEPTED', 'REVOKED'].includes(decision)) return false;
  const literalBody = String(body || '').trim();
  if (!literalBody) return false;
  return /profile_data_before_consent/i.test(decision)
    || evaluateProfileDataEvidence(literalBody).containsProfileData;
}
""")

replace_once(gate, """      consentDecision: decision,
      waMessageId
""", """      consentDecision: decision,
      waMessageId,
      preConsentProtected: isPreConsentProtectedTextEvidence(decision, body, message)
""")

replace_once(gate, """          consentDecision: decision,
          waMessageId,
          consentGateProcessing: { state: 'PENDING', decision }
""", """          consentDecision: decision,
          waMessageId,
          preConsentProtected: isPreConsentProtectedTextEvidence(decision, inboundText(message), message),
          consentGateProcessing: { state: 'PENDING', decision }
""")

repo = 'src/services/conversationMessageRepository.js'
replace_once(repo, """  const recentConversation = [...rows]
    .reverse()
    .map((row) => ({
      direction: row.direction,
      body: String(row.body ?? '')
    }));
""", """  const recentConversation = [...rows]
    .reverse()
    .filter((row) => !(
      row?.direction === MessageDirection.INBOUND
      && row?.rawPayload?.preConsentProtected === true
    ))
    .map((row) => ({
      direction: row.direction,
      body: String(row.body ?? '')
    }));
""")

doc = 'lorren_comportamiento_completo.md'
replace_once(doc, """- persistir datos personales antes de autorización válida;
""", """- persistir datos personales como entidades del perfil, documentos o archivos antes de autorización válida;
""")
replace_once(doc, """La solicitud debe ser idempotente: mientras esté pendiente, un mismo evento, lote o reintento no puede producir otra solicitud.

Si llega un archivo antes del consentimiento, el sistema debe informar brevemente que no fue guardado y solicitar una sola autorización. Tras aceptar, debe pedir reenviar el archivo únicamente si efectivamente no fue persistido.
""", """La solicitud debe ser idempotente: mientras esté pendiente, un mismo evento, lote o reintento no puede producir otra solicitud.

Para trazabilidad operativa, el texto inbound recibido antes del consentimiento puede conservarse literalmente en el historial conversacional accesible al personal autorizado. Esa evidencia debe quedar marcada como preconsentimiento protegido y no puede alimentar la interpretación automática posterior, prellenar el perfil ni convertirse en una entidad persistida del candidato sin autorización válida. El texto no debe duplicarse innecesariamente en logs o metadata técnica.

Si llega un archivo antes del consentimiento, el sistema debe informar brevemente que no fue guardado y solicitar una sola autorización. Tras aceptar, debe pedir reenviar el archivo únicamente si efectivamente no fue persistido. Esta excepción de trazabilidad aplica al texto; no autoriza descargar o conservar archivos preconsentimiento.
""")

order = 'test/dataConsentOrderRecovery.test.js'
replace_once(order, """  assert.deepEqual(evaluateConsentBoundary(candidate, message), {
    block: true,
    reason: 'protected_step_without_consent'
  });
""", """  assert.deepEqual(evaluateConsentBoundary(candidate, message), {
    block: true,
    reason: 'candidate_wants_to_continue'
  });
""")

rc = 'test/conversationalReleaseCandidatePreConsent.test.js'
replace_once(rc, """  assert.equal(harness.inboundRows.length, 1);
  assert.match(harness.inboundRows[0].body || '', /no fue almacenado|no se almacenó/i);
  assert.doesNotMatch(harness.inboundRows[0].body || '', /TEST-100000001/);
  assert.doesNotMatch(harness.inboundRows[0].body || '', /^\\[.*\\]$/);
  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);
  assert.equal(harness.providerOutbound.length, 0);
  assert.equal(harness.outboundRows.length, 0);
  assert.equal(harness.getCandidate().botPaused, true);
  assert.equal(harness.candidateUpdates.length, 0);
""", """  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.inboundRows[0].body, 'Mi cédula es TEST-100000001');
  assert.equal(harness.inboundRows[0].rawPayload?.preConsentProtected, true);
  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);
  assert.equal(harness.providerOutbound.length, 0);
  assert.equal(harness.outboundRows.length, 0);
  assert.equal(harness.getCandidate().botPaused, true);
  assert.equal(harness.candidateUpdates.length, 0);
""")
replace_once(rc, """test('TEST-RC-PRECONSENT-RAW: deduplicar no persiste texto personal crudo', async () => {
  const harness = buildHarness();
  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-RAW-BODY');

  assert.equal(observed.nextCalls, 0);
  assert.deepEqual(observed.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.inboundRows[0].waMessageId, 'TEST-RC-RAW-BODY');
  assert.match(harness.inboundRows[0].body || '', /no fue almacenado|no se almacenó/i);
  assert.doesNotMatch(harness.inboundRows[0].body || '', /TEST-100000001/);
  assert.doesNotMatch(harness.inboundRows[0].body || '', /^\\[.*\\]$/);
  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);
  assert.equal(harness.inboundRows[0].rawPayload?.consentGateProcessing?.state, 'COMPLETED');
  assert.equal(harness.providerOutbound.length, 1);
});
""", """test('TEST-RC-PRECONSENT-RAW: conserva texto solo como auditoría protegida', async () => {
  const harness = buildHarness();
  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-RAW-BODY');

  assert.equal(observed.nextCalls, 0);
  assert.deepEqual(observed.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.inboundRows[0].waMessageId, 'TEST-RC-RAW-BODY');
  assert.equal(harness.inboundRows[0].body, 'Mi cédula es TEST-100000001');
  assert.equal(harness.inboundRows[0].rawPayload?.preConsentProtected, true);
  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);
  assert.equal(harness.inboundRows[0].rawPayload?.consentGateProcessing?.state, 'COMPLETED');
  assert.equal(harness.candidateUpdates.some((update) => Object.hasOwn(update, 'documentNumber')), false);
  assert.equal(harness.providerOutbound.length, 1);
});
""")
