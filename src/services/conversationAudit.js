import {
  SESSION_GAP_MS,
  RESPONSE_STALE_MS,
  SEVERITY_RANK,
  asObject,
  toDate,
  sourceText,
  hashLabel,
  normalizeText,
  textSimilarity,
  buildIssue,
  addIssue,
  startsWithGreeting,
  sentenceCount,
  hasMarkdownList,
  hasTechnicalLeak,
  asksIdentity,
  mentionsIdentity,
  detectQuestionTopic,
  responseAddressesTopic,
  isDataRequest,
  inboundEvidenceFields,
  requestedFields,
  unsupportedClaim,
  detectLoopGuard,
  activeBookingCount,
  candidateHasCv,
  conversationRisk,
  compareConversationRisk,
  isAuditableMessage,
  classifyConversationActor,
  redactConversationText,
  resolveConversationAuditRange
} from './conversationAuditPolicy.js';

export {
  isAuditableMessage,
  classifyConversationActor,
  redactConversationText,
  resolveConversationAuditRange
} from './conversationAuditPolicy.js';

export function segmentConversationMessages(messages = [], gapMs = SESSION_GAP_MS) {
  const byCandidate = new Map();
  for (const message of messages.filter(isAuditableMessage)) {
    if (!message?.candidateId) continue;
    if (!byCandidate.has(message.candidateId)) byCandidate.set(message.candidateId, []);
    byCandidate.get(message.candidateId).push(message);
  }
  const sessions = [];
  for (const candidateMessages of byCandidate.values()) {
    candidateMessages.sort((a, b) => (toDate(a.createdAt) - toDate(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    let current = [];
    for (const message of candidateMessages) {
      const previous = current.at(-1);
      const gap = previous ? toDate(message.createdAt) - toDate(previous.createdAt) : 0;
      if (current.length && gap > gapMs) {
        sessions.push(current);
        current = [];
      }
      current.push(message);
    }
    if (current.length) sessions.push(current);
  }
  return sessions;
}

export function analyzeConversationSession(messages = [], options = {}) {
  if (!messages.length) return null;
  const candidate = messages.at(-1)?.candidate || messages[0]?.candidate || {};
  const issues = [];
  const actors = messages.map(classifyConversationActor);
  const providedFields = new Set();
  const normalizedBotReplies = new Map();
  const responseLatencies = [];
  let greetingCount = 0;
  let previousBotMessage = null;
  let awaitingInboundAfterHuman = false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const actor = actors[index];
    const body = String(message.body || '');
    const payload = asObject(message.rawPayload);

    if (actor === 'candidate') {
      awaitingInboundAfterHuman = false;
      for (const field of inboundEvidenceFields(message)) providedFields.add(field);
      const nextOutboundIndex = actors.findIndex((nextActor, nextIndex) => nextIndex > index && nextActor !== 'candidate');
      if (nextOutboundIndex >= 0) {
        const latency = toDate(messages[nextOutboundIndex].createdAt) - toDate(message.createdAt);
        if (latency >= 0) responseLatencies.push(latency);
        const topic = detectQuestionTopic(body);
        const nextActor = actors[nextOutboundIndex];
        const nextReply = String(messages[nextOutboundIndex].body || '');
        if (topic && nextActor === 'bot' && !responseAddressesTopic(nextReply, topic)
          && (topic !== 'general' || isDataRequest(nextReply))) {
          addIssue(issues, buildIssue('QUESTION_NOT_ANSWERED', `La pregunta sobre ${topic} no fue respondida antes de continuar el flujo.`, messages[nextOutboundIndex], candidate));
        }
      }
      continue;
    }

    if (actor === 'human') {
      awaitingInboundAfterHuman = true;
      previousBotMessage = null;
      continue;
    }

    if (actor !== 'bot') continue;

    if (awaitingInboundAfterHuman) {
      addIssue(issues, buildIssue('BOT_OVER_HUMAN', 'Se detectó una salida automática después de un mensaje humano y antes de una nueva respuesta del candidato.', message, candidate));
    }

    const messageAt = toDate(message.createdAt);
    const consentAcceptedAt = toDate(candidate.dataConsentAcceptedAt);
    if (isDataRequest(body) && (!consentAcceptedAt || (messageAt && messageAt < consentAcceptedAt))) {
      addIssue(issues, buildIssue(
        'CONSENT_SEQUENCE_BROKEN',
        'El bot solicitó datos personales antes de que existiera una autorización aceptada para ese momento.',
        message,
        candidate
      ));
    }

    const replyKind = String(payload.replyKind || '').toUpperCase();
    const configuredVacancyInfo = Boolean(
    candidate?.vacancy?.roleDescription
    || candidate?.vacancy?.requirements
    || candidate?.vacancy?.conditions
    || candidate?.vacancy?.operationAddress
    || candidate?.vacancy?.requiredDocuments
    || Number.isInteger(candidate?.vacancy?.minAge)
    || Number.isInteger(candidate?.vacancy?.maxAge)
    || ['YES', 'NO'].includes(String(candidate?.vacancy?.experienceRequired || '').toUpperCase())
  );
  if (replyKind === 'ACTIVE_VACANCY_INTEREST_PROMPT'
    && configuredVacancyInfo
    && !/\b(requisitos?|condiciones?|zona de operaci[oó]n|el cargo consiste|documentos? registrados?|rango de edad|edad m[ií]nima|edad m[aá]xima|edad configurada|experiencia requerida|se requiere experiencia|no se requiere experiencia)\b/i.test(body)) {
      addIssue(issues, buildIssue(
        'VACANCY_INFO_SKIPPED',
        'La vacante quedó identificada, pero el mensaje pasó a preguntar por interés sin compartir la información configurada.',
        message,
        candidate
      ));
    }

    if (startsWithGreeting(body)) {
      greetingCount += 1;
      if (greetingCount > 1) addIssue(issues, buildIssue('REPEATED_GREETING', 'El bot volvió a saludar dentro de la misma sesión.', message, candidate));
    }

    if (sentenceCount(body) > 3 || body.length > 700) {
      addIssue(issues, buildIssue('EXCESSIVE_LENGTH', `La respuesta tiene ${sentenceCount(body)} oraciones y ${body.length} caracteres.`, message, candidate));
    }
    if (hasMarkdownList(body)) addIssue(issues, buildIssue('MARKDOWN_OR_LIST', 'La respuesta usa viñetas o numeración.', message, candidate));
    if (hasTechnicalLeak(body)) addIssue(issues, buildIssue('TECHNICAL_LEAK', 'La respuesta expone vocabulario técnico o interno.', message, candidate));

    const previousInbound = index > 0 ? messages.slice(0, index).reverse().find((item) => classifyConversationActor(item) === 'candidate') : null;
    if (mentionsIdentity(body) && !asksIdentity(previousInbound?.body || '')) {
      addIssue(issues, buildIssue('UNNECESSARY_IDENTITY_DISCLOSURE', 'La identidad técnica del asistente no fue solicitada por el candidato.', message, candidate));
    }

    const claimTopic = !detectQuestionTopic(body) && !isDataRequest(body)
      ? unsupportedClaim(body, candidate)
      : null;
    if (claimTopic) {
      addIssue(issues, buildIssue('UNSUPPORTED_SENSITIVE_CLAIM', `La respuesta menciona ${claimTopic} sin respaldo suficiente en los campos autorizados de la vacante.`, message, candidate));
    }

    if (!/\b(confirma|confirmar|correcto|es correcto)\b/i.test(body)) {
      for (const field of requestedFields(body)) {
        if (providedFields.has(field)) {
          addIssue(issues, buildIssue('REPEATED_DATA_REQUEST', `El bot volvió a solicitar el campo ${field} después de que ya apareció en mensajes del candidato.`, message, candidate));
        }
      }
    }

    const normalized = normalizeText(body);
    if (normalized) {
      normalizedBotReplies.set(normalized, (normalizedBotReplies.get(normalized) || 0) + 1);
      if (previousBotMessage && textSimilarity(previousBotMessage.body, body) >= 0.82) {
        addIssue(issues, buildIssue('DUPLICATE_REPLY', 'Dos respuestas automáticas consecutivas son sustancialmente similares.', message, candidate));
      }
    }
    if (detectLoopGuard(payload)) addIssue(issues, buildIssue('LOOP_GUARD_USED', 'El guard de repetición intervino en este turno.', message, candidate));

    const deliveryState = String(asObject(payload.delivery).state || '').toUpperCase();
    if (['FAILED', 'UNKNOWN'].includes(deliveryState)) {
      addIssue(issues, buildIssue('DELIVERY_FAILURE', `Estado de entrega: ${deliveryState}.`, message, candidate));
    }
    previousBotMessage = message;
  }

  for (const [reply, count] of normalizedBotReplies.entries()) {
    if (count >= 3) {
      addIssue(issues, buildIssue('LOOP_PATTERN', `La misma estructura de respuesta apareció ${count} veces: “${redactConversationText(reply.slice(0, 90), candidate)}”.`, null, candidate));
    }
  }

  const lastMessage = messages.at(-1);
  const auditEnd = toDate(options.now) || new Date();
  if (classifyConversationActor(lastMessage) === 'candidate'
    && auditEnd - toDate(lastMessage.createdAt) >= RESPONSE_STALE_MS) {
    if (candidate.botPaused) {
      addIssue(issues, buildIssue('MANUAL_REVIEW_PENDING', redactConversationText(candidate.botPauseReason || '', candidate) || 'El bot está pausado y la conversación espera atención humana.', lastMessage, candidate));
    } else {
      addIssue(issues, buildIssue('UNANSWERED_INBOUND', 'El último mensaje del candidato no tiene una salida posterior registrada.', lastMessage, candidate));
    }
  }

  const activeBookings = activeBookingCount(candidate);
  if (options.checkCurrentState !== false) {
    if (candidate.currentStep === 'SCHEDULED' && activeBookings === 0) {
      addIssue(issues, buildIssue('SCHEDULED_WITHOUT_BOOKING', 'El candidato figura como SCHEDULED pero no tiene una reserva activa seleccionada.', lastMessage, candidate));
    }
    if (candidate.status === 'RECHAZADO' && candidate.currentStep !== 'DONE') {
      addIssue(issues, buildIssue('REJECTED_WITH_OPEN_STEP', `Estado RECHAZADO con paso ${candidate.currentStep || 'sin paso'}.`, lastMessage, candidate));
    }
    if (candidate.botPaused && !String(candidate.botPauseReason || '').trim()) {
      addIssue(issues, buildIssue('PAUSED_WITHOUT_REASON', 'El candidato está pausado sin un motivo registrado.', lastMessage, candidate));
    }
    if (candidate.currentStep === 'ASK_CV' && candidateHasCv(candidate)) {
      addIssue(issues, buildIssue('CV_RECEIVED_BUT_STUCK', 'Existe una hoja de vida registrada, pero el flujo continúa en ASK_CV.', lastMessage, candidate));
    }
    if (candidate.currentStep === 'DONE'
      && candidate.vacancy?.schedulingEnabled
      && candidate.gender !== 'FEMALE'
      && activeBookings === 0
      && candidate.status !== 'RECHAZADO'
      && candidate.status !== 'CONTRATADO'
      && candidateHasCv(candidate)
      && !candidate.botPaused) {
      addIssue(issues, buildIssue('PREMATURE_DONE', 'El proceso terminó con agenda habilitada, hoja de vida recibida y sin reserva activa.', lastMessage, candidate));
    }
  }

  issues.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || a.code.localeCompare(b.code));
  const startedAt = toDate(messages[0].createdAt);
  const endedAt = toDate(lastMessage.createdAt);
  const transcript = messages.map((message) => ({
    id: hashLabel(message.id, 'msg'),
    at: toDate(message.createdAt)?.toISOString() || null,
    actor: classifyConversationActor(message),
    direction: message.direction,
    messageType: message.messageType,
    source: sourceText(asObject(message.rawPayload)) || null,
    action: asObject(message.rawPayload).action || null,
    body: redactConversationText(message.body, candidate)
  }));

  const sourceCounts = transcript.reduce((acc, message) => {
    const source = message.actor === 'bot' ? (message.source || 'bot_unknown') : message.actor;
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});

  return {
    id: hashLabel(`${messages[0].candidateId}|${startedAt?.toISOString()}`, 'conv'),
    candidate: hashLabel(messages[0].candidateId, 'cand'),
    vacancy: candidate.vacancy ? `${candidate.vacancy.title || candidate.vacancy.role || 'Vacante'} · ${candidate.vacancy.city || 'Sin ciudad'}` : 'Sin vacante',
    startedAt: startedAt?.toISOString() || null,
    endedAt: endedAt?.toISOString() || null,
    durationMinutes: startedAt && endedAt ? Math.round((endedAt - startedAt) / 60000) : 0,
    messageCount: messages.length,
    inboundCount: actors.filter((actor) => actor === 'candidate').length,
    outboundCount: actors.filter((actor) => actor !== 'candidate').length,
    botCount: actors.filter((actor) => actor === 'bot').length,
    humanCount: actors.filter((actor) => actor === 'human').length,
    responseLatencyMs: responseLatencies,
    averageResponseSeconds: responseLatencies.length ? Math.round(responseLatencies.reduce((sum, value) => sum + value, 0) / responseLatencies.length / 1000) : null,
    finalState: {
      currentStep: candidate.currentStep || null,
      status: candidate.status || null,
      botPaused: Boolean(candidate.botPaused),
      botPauseReason: candidate.botPaused ? redactConversationText(candidate.botPauseReason || '', candidate) || null : null,
      activeBookings
    },
    sourceCounts,
    issues,
    risk: conversationRisk(issues),
    transcript
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildRecommendations(issueCounts) {
  const mapping = {
    BOT_OVER_HUMAN: 'Endurecer el bloqueo de respuestas automáticas cuando el último outbound sea humano.',
    QUESTION_NOT_ANSWERED: 'Dar prioridad determinística a preguntas antes de continuar la recolección de datos.',
    REPEATED_DATA_REQUEST: 'Persistir y consultar evidencia por turno antes de volver a solicitar campos.',
    LOOP_PATTERN: 'Revisar las causas que activan el guard de repetición y los estados sin progreso.',
    TECHNICAL_LEAK: 'Aplicar sanitización final obligatoria a todas las salidas, incluidas rutas de error.',
    UNSUPPORTED_SENSITIVE_CLAIM: 'Bloquear afirmaciones de salario, horario, ubicación, beneficios o documentos que no estén en la vacante.',
    SCHEDULED_WITHOUT_BOOKING: 'Hacer atómica la transición a SCHEDULED con la creación o validación de la reserva.',
    PREMATURE_DONE: 'Impedir DONE cuando la agenda está habilitada y no existe reserva ni pausa justificada.',
    CV_RECEIVED_BUT_STUCK: 'Reconciliar ASK_CV inmediatamente después de persistir una hoja de vida válida.',
    UNANSWERED_INBOUND: 'Revisar silencios no intencionales, errores de envío y ramas que terminan sin reply.',
    VACANCY_INFO_SKIPPED: 'Entregar la información configurada de la vacante antes de solicitar confirmación de interés.',
    CONSENT_SEQUENCE_BROKEN: 'Bloquear cualquier solicitud de datos personales hasta que exista autorización aceptada para ese momento.'
  };
  return Object.entries(issueCounts)
    .filter(([code, count]) => count > 0 && mapping[code])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, count]) => ({ code, count, recommendation: mapping[code] }));
}

export function buildConversationAuditReport(messages = [], options = {}) {
  const sessions = segmentConversationMessages(messages, options.sessionGapMs || SESSION_GAP_MS);
  const latestSessionByCandidate = new Map();
  sessions.forEach((session, index) => {
    const candidateId = session[0]?.candidateId;
    if (candidateId) latestSessionByCandidate.set(candidateId, index);
  });
  const conversations = sessions
    .map((session, index) => analyzeConversationSession(session, {
      ...options,
      checkCurrentState: latestSessionByCandidate.get(session[0]?.candidateId) === index
    }))
    .filter(Boolean)
    .sort(compareConversationRisk);
  const issueCounts = {};
  const sourceCounts = {};
  const allLatencies = [];
  for (const conversation of conversations) {
    for (const issue of conversation.issues) issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
    for (const [source, count] of Object.entries(conversation.sourceCounts)) sourceCounts[source] = (sourceCounts[source] || 0) + count;
    allLatencies.push(...conversation.responseLatencyMs);
  }
  const adequate = conversations.filter((item) => item.risk.label === 'ADECUADA').length;
  const review = conversations.filter((item) => item.risk.label === 'REVISAR').length;
  const highRisk = conversations.filter((item) => item.risk.label === 'RIESGO_ALTO').length;
  const uniqueCandidates = new Set(messages.filter(isAuditableMessage).map((item) => item.candidateId).filter(Boolean)).size;
  return {
    generatedAt: (toDate(options.now) || new Date()).toISOString(),
    range: {
      start: toDate(options.start)?.toISOString() || null,
      end: toDate(options.end)?.toISOString() || null,
      days: options.days || null
    },
    methodology: {
      everyVisibleMessageIncluded: true,
      openAiCalls: 0,
      piiRedacted: true,
      sessionGapHours: Math.round((options.sessionGapMs || SESSION_GAP_MS) / 3600000),
      limitations: [
        'Los estados de Candidate son el estado actual, no una fotografía histórica por cada turno.',
        'Las reglas lingüísticas detectan riesgos y requieren revisión humana para confirmar casos ambiguos.'
      ]
    },
    summary: {
      conversations: conversations.length,
      uniqueCandidates,
      messages: messages.filter(isAuditableMessage).length,
      adequate,
      review,
      highRisk,
      adequateRate: conversations.length ? Math.round((adequate / conversations.length) * 100) : 0,
      averageResponseSeconds: allLatencies.length ? Math.round(allLatencies.reduce((sum, value) => sum + value, 0) / allLatencies.length / 1000) : null,
      p95ResponseSeconds: allLatencies.length ? Math.round(percentile(allLatencies, 95) / 1000) : null
    },
    issueCounts,
    sourceCounts,
    recommendations: buildRecommendations(issueCounts),
    conversations
  };
}

export async function loadConversationAuditReport(prisma, options = {}) {
  if (!prisma?.message || typeof prisma.message.findMany !== 'function') {
    throw new Error('conversation_audit_prisma_contract_invalid');
  }
  const range = resolveConversationAuditRange(options);
  const messages = await prisma.message.findMany({
    where: { createdAt: { gte: range.start, lte: range.end } },
    orderBy: [{ candidateId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      candidateId: true,
      direction: true,
      messageType: true,
      body: true,
      rawPayload: true,
      respondedAt: true,
      createdAt: true,
      candidate: {
        select: {
          id: true,
          fullName: true,
          phone: true,
          documentNumber: true,
          currentStep: true,
          status: true,
          gender: true,
          botPaused: true,
          botPauseReason: true,
          vacancyId: true,
          cvStorageKey: true,
          cvOriginalName: true,
          vacancy: {
            select: {
              title: true,
              role: true,
              city: true,
              roleDescription: true,
              requirements: true,
              conditions: true,
              operationAddress: true,
              interviewAddress: true,
              requiredDocuments: true,
              schedulingEnabled: true,
              acceptingApplications: true,
              isActive: true
            }
          },
          interviewBookings: {
            where: { status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] } },
            select: { id: true, status: true, scheduledAt: true }
          }
        }
      }
    }
  });
  return buildConversationAuditReport(messages, { ...options, ...range, now: options.now || range.end });
}
