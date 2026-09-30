import { ConversationTurnInputSchema } from '../contracts/ConversationTurnInputSchema.js';
import { getCandidateReadiness } from '../../services/candidateReadiness.js';
import { getResidenceFieldConfig } from '../../services/candidateData.js';
import { detectGenderFromEvidence } from '../../services/genderEvidencePolicy.js';
import { resolveCampaignForReferral } from '../../services/campaignAttribution.js';

async function resolveInboundVacancy(message, prisma) {
  const referral = asRecord(message.referral);
  if (!Object.values(referral).some((value) => typeof value === 'string' && value.trim())) {
    const resolvedVacancy = asRecord(message.resolvedVacancy);
    if (typeof resolvedVacancy.id === 'string' && resolvedVacancy.id.trim()) {
      return { vacancy: resolvedVacancy, attribution: { source: 'ORGANIC' } };
    }
    return { vacancy: null, attribution: { source: 'ORGANIC' } };
  }
  const campaigns = await prisma.campaign.findMany({
    where: { isActive: true }, include: { vacancy: true }
  });
  const resolution = resolveCampaignForReferral(campaigns, { referral });
  let vacancy = resolution.campaign?.vacancy ?? null;
  // An objective ad identity must never fall back to a coincidental headline.
  if (!vacancy && !referral.ad_id && !referral.source_id
    && typeof referral.headline === 'string' && referral.headline.trim()
    && resolution.reason === 'no_campaign_match') {
    const matches = await prisma.vacancy.findMany({
      where: { title: { equals: referral.headline.trim(), mode: 'insensitive' } },
      take: 2
    });
    if (matches.length === 1) vacancy = matches[0];
  }
  return { vacancy, attribution: { source: 'META_ADS' } };
}

function vacancySnapshot(vacancy) {
  if (!vacancy) return null;
  return {
    id: vacancy.id ?? null,
    title: vacancy.title ?? null,
    role: vacancy.role ?? null,
    city: vacancy.city ?? null,
    isActive: vacancy.isActive ?? null,
    acceptingApplications: vacancy.acceptingApplications ?? null,
    schedulingEnabled: vacancy.schedulingEnabled ?? null,
    interviewSchedulingEnabled: vacancy.interviewSchedulingEnabled ?? null,
    requirements: vacancy.requirements ?? null,
    conditions: vacancy.conditions ?? null,
    roleDescription: vacancy.roleDescription ?? null,
    requiredDocuments: vacancy.requiredDocuments ?? null,
    operationAddress: vacancy.operationAddress ?? null,
    minAge: vacancy.minAge ?? null,
    maxAge: vacancy.maxAge ?? null,
    experienceRequired: ['YES', 'NO', 'INDIFFERENT'].includes(
      String(vacancy.experienceRequired || '').toUpperCase()
    ) ? String(vacancy.experienceRequired).toUpperCase() : null,
    experienceTimeText: vacancy.experienceTimeText ?? null,
    experienceTime: vacancy.experienceTime ?? vacancy.experienceTimeText ?? null,
    locationType: getResidenceFieldConfig(vacancy).field === 'locality' ? 'localidad' : 'barrio',
    operation: vacancy.operation
      ? {
          name: vacancy.operation.name ?? null,
          city: vacancy.operation.city ? { name: vacancy.operation.city.name ?? null } : null
        }
      : null
  };
}

function normalizedMessageType(value) {
  if (['document', 'image', 'audio'].includes(value)) return value;
  if (value === 'text' || value === 'interactive' || value === 'button') return 'text';
  return 'unknown';
}

function currentAttachments(message) {
  const type = normalizedMessageType(message.type);
  if (!['document', 'image', 'audio'].includes(type)) return [];

  const media = asRecord(message.media);
  if (typeof media.mediaId !== 'string' || !media.mediaId.trim()) return [];
  if (typeof media.mimeType !== 'string' || !media.mimeType.trim()) return [];

  const allowedStatuses = new Set(['received', 'downloading', 'downloaded', 'processed', 'failed']);
  const status = allowedStatuses.has(media.status) ? media.status : 'received';

  return [{
    providerId: media.mediaId.trim(),
    type,
    fileName: typeof media.fileName === 'string' && media.fileName.trim()
      ? media.fileName.trim()
      : null,
    mimeType: media.mimeType.trim(),
    extractedText: typeof media.extractedText === 'string' ? media.extractedText : null,
    status
  }];
}

function isProcessedCvAttachment(attachment) {
  return attachment.type === 'document'
    && attachment.status === 'processed'
    && typeof attachment.extractedText === 'string'
    && attachment.extractedText.trim().length > 0;
}

function attachmentItems(attachments) {
  return attachments.map((attachment) => ({
    type: attachment.type,
    mediaId: attachment.providerId,
    providerId: attachment.providerId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    caption: null,
    isCv: isProcessedCvAttachment(attachment),
    extractedText: attachment.extractedText,
    status: attachment.status
  }));
}

function turnBringsProcessedCv(attachments) {
  return attachments.some(isProcessedCvAttachment);
}

/** @param {unknown} value */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const CANDIDATE_FACT_FIELDS = Object.freeze([
  'phone',
  'vacancyId',
  'recruitmentCity',
  'recruitmentRole',
  'dataConsentStatus',
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'neighborhood',
  'locality',
  'experienceInfo',
  'experienceTime',
  'experienceSummary',
  'medicalRestrictions',
  'transportMode',
  'status',
  'currentStep',
  'cvOriginalName',
  'cvMimeType',
  'cvStorageKey',
  'inactivityReminderSent',
  'botPaused',
  'botResumeMode',
  'stage',
  'reminderState',
  'reminderScheduledFor',
  'lastInboundAt',
  'lastOutboundAt'
]);

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requirePrisma(dependencies) {
  const prisma = dependencies?.prisma;
  if (typeof prisma?.candidate?.findUnique !== 'function'
    || typeof prisma?.candidate?.create !== 'function'
    || typeof prisma?.message?.findMany !== 'function') {
    throw new TypeError('dependencies.prisma must expose candidate.findUnique, candidate.create and message.findMany');
  }
  return prisma;
}

function isoDate(value, fallback = null) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function interpretedGender(interpretation) {
  for (const source of [
    interpretation?.providedFields,
    interpretation?.detectedFields,
    interpretation?.extractedFields
  ]) {
    const value = asRecord(source).gender;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function interpretedRecruitmentFacts(interpretation) {
  const fields = asRecord(interpretation?.fields);
  const provided = asRecord(interpretation?.providedFields);
  const detected = asRecord(interpretation?.detectedFields);
  const extracted = asRecord(interpretation?.extractedFields);
  return {
    recruitmentCity: firstString(
      fields.recruitmentCity,
      provided.recruitmentCity,
      extracted.recruitmentCity,
      detected.recruitmentCity,
      detected.cityHint,
      extracted.cityHint,
      provided.cityHint
    ),
    recruitmentRole: firstString(
      fields.recruitmentRole,
      provided.recruitmentRole,
      extracted.recruitmentRole,
      detected.recruitmentRole,
      detected.roleHint,
      extracted.roleHint,
      provided.roleHint
    )
  };
}

function buildCandidateFacts(candidate, interpretation) {
  const facts = Object.fromEntries(CANDIDATE_FACT_FIELDS
    .filter((field) => candidate[field] !== undefined)
    .map((field) => [field, candidate[field] instanceof Date
      ? candidate[field].toISOString()
      : candidate[field]]));
  const vacancy = candidate.vacancy;

  if (candidate.experienceTime !== undefined) {
    facts.candidateExperienceTime = candidate.experienceTime;
  }

  facts.consentGranted = candidate.dataConsentStatus === 'ACCEPTED';
  const detectedGender = interpretedGender(interpretation);
  if ((!facts.gender || facts.gender === 'UNKNOWN') && detectedGender) {
    facts.gender = detectedGender;
  }

  const recruitmentFacts = interpretedRecruitmentFacts(interpretation);
  if (!facts.recruitmentCity && recruitmentFacts.recruitmentCity) {
    facts.recruitmentCity = recruitmentFacts.recruitmentCity;
  }
  if (!facts.recruitmentRole && recruitmentFacts.recruitmentRole) {
    facts.recruitmentRole = recruitmentFacts.recruitmentRole;
  }

  if (vacancy) {
    facts.vacancyActive = vacancy.isActive;
    facts.vacancyAcceptingApplications = vacancy.acceptingApplications;
    facts.acceptingApplications = vacancy.acceptingApplications;
    facts.vacancyRole = vacancy.role || vacancy.title;
    facts.vacancyCity = vacancy.city;
    facts.recruitmentCity = facts.recruitmentCity || vacancy.city;
    facts.recruitmentRole = facts.recruitmentRole || vacancy.role || vacancy.title;
    facts.minAge = vacancy.minAge;
    facts.maxAge = vacancy.maxAge;
    facts.experienceRequired = vacancy.experienceRequired;
    facts.experienceTime = vacancy.experienceTime ?? vacancy.experienceTimeText;
    facts.schedulingEnabled = vacancy.schedulingEnabled;
    facts.locationType = getResidenceFieldConfig(vacancy).field === 'locality'
      ? 'localidad'
      : 'barrio';
  }

  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}

function mapHistory(messages) {
  return [...messages].reverse().map((message) => ({
    role: message.direction === 'INBOUND' ? 'user' : 'assistant',
    text: typeof message.body === 'string' ? message.body : '',
    occurredAt: isoDate(message.createdAt, new Date(0).toISOString())
  }));
}

function outboundIdentity(message) {
  if (!message) return null;
  const payload = asRecord(message.rawPayload);
  if (typeof payload.directive === 'string' && payload.directive.trim()) {
    return `directive:${payload.directive.trim()}`;
  }
  const text = String(message.body || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-CO');
  return text ? `text:${text}` : null;
}

export function deriveCandidatePendingFields(candidate) {
  const fields = [];
  if (!candidate.recruitmentCity) fields.push('recruitmentCity');
  if (!candidate.vacancyId) {
    if (!candidate.recruitmentRole) fields.push('recruitmentRole');
    fields.push('vacancyId');
    return [...new Set(fields)];
  }
  if (candidate.dataConsentStatus !== 'ACCEPTED') return ['dataConsent'];

  const readiness = getCandidateReadiness(candidate, candidate.vacancy || null);
  fields.push(...(readiness.missingFields || []));
  if (!readiness.hasValidCv) fields.push('cv');
  return [...new Set(fields)].filter((field) => field !== 'gender');
}

function mapInterpretation(inboundMessage, lastBotQuestion = null) {
  if (inboundMessage.isSystemAction === true) {
    return { intent: requireString(inboundMessage.intent, 'inboundMessage.intent') };
  }

  const source = asRecord(inboundMessage.interpretation);
  const interpretation = {};
  if (typeof source.intent === 'string' && source.intent.trim()) {
    interpretation.intent = source.intent.trim();
  }
  for (const key of ['providedFields', 'detectedFields', 'extractedFields']) {
    if (Object.keys(asRecord(source[key])).length) interpretation[key] = source[key];
  }

  const candidateFieldNames = new Set([
    'fullName', 'documentType', 'documentNumber', 'age', 'gender',
    'recruitmentCity', 'recruitmentRole', 'neighborhood', 'locality',
    'medicalRestrictions', 'transportMode', 'experienceInfo',
    'experienceTime', 'experienceSummary'
  ]);
  const mergedFields = {
    ...asRecord(source.extractedFields),
    ...asRecord(source.detectedFields),
    ...asRecord(source.providedFields),
    ...asRecord(source.fields)
  };
  const city = firstString(
    mergedFields.recruitmentCity,
    mergedFields.city,
    mergedFields.cityHint
  );
  const role = firstString(
    mergedFields.recruitmentRole,
    mergedFields.role,
    mergedFields.roleHint
  );
  if (city) mergedFields.recruitmentCity = city;
  if (role) mergedFields.recruitmentRole = role;

  const fields = Object.fromEntries(
    Object.entries(mergedFields).filter(([field]) => candidateFieldNames.has(field))
  );
  if (Object.keys(fields).length) interpretation.fields = fields;
  const sourceScheduling = asRecord(source.scheduling);
  const sourceSlot = asRecord(sourceScheduling.slot);
  if (Object.keys(sourceSlot).length) {
    interpretation.scheduling = {
      slot: {
        slotId: sourceSlot.slotId ?? null,
        startsAt: sourceSlot.startsAt,
        timezone: sourceSlot.timezone
      }
    };
  }
  const consentDecision = asRecord(source.consent).decision;
  if (['ACCEPTED', 'REJECTED', 'REVOKED', 'PENDING'].includes(consentDecision)) {
    interpretation.consent = { decision: consentDecision };
  }

  const alreadyDetected = ['providedFields', 'detectedFields', 'extractedFields']
    .some((key) => typeof asRecord(interpretation[key]).gender === 'string');
  const localGender = alreadyDetected
    ? null
    : detectGenderFromEvidence(inboundMessage.text, {
      fullName: inboundMessage.fullName
        || asRecord(source.providedFields).fullName
        || asRecord(source.detectedFields).fullName
        || asRecord(source.extractedFields).fullName
    });
  if (localGender) {
    interpretation.detectedFields = {
      ...asRecord(interpretation.detectedFields),
      gender: localGender
    };
  }
  return Object.keys(interpretation).length ? interpretation : undefined;
}

async function loadOrCreateCandidate(prisma, phone) {
  const query = { where: { phone }, include: { vacancy: true } };
  const existing = await prisma.candidate.findUnique(query);
  if (existing) return existing;

  try {
    return await prisma.candidate.create({
      data: { phone },
      include: { vacancy: true }
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const concurrentlyCreated = await prisma.candidate.findUnique(query);
    if (concurrentlyCreated) return concurrentlyCreated;
    throw error;
  }
}

export class ConversationTurnInputBuildError extends Error {
  constructor(issues) {
    super('Conversation turn input mapping failed strict validation');
    this.name = 'ConversationTurnInputBuildError';
    this.issues = issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message
    }));
  }
}

/** Build one production-ready core input from one normalized Meta message. */
export async function buildConversationTurnInput(inboundMessage, dependencies = {}) {
  const message = asRecord(inboundMessage);
  const prisma = requirePrisma(dependencies);
  const phone = requireString(message.from, 'inboundMessage.from');
  const messageId = requireString(message.messageId, 'inboundMessage.messageId');
  const candidate = await loadOrCreateCandidate(prisma, phone);
  const inboundContext = await resolveInboundVacancy(message, prisma);
  const effectiveCandidate = inboundContext.vacancy
    ? {
        ...candidate,
        vacancy: candidate.vacancy || inboundContext.vacancy,
        vacancyId: candidate.vacancyId || inboundContext.vacancy.id,
        recruitmentCity: candidate.recruitmentCity || inboundContext.vacancy.city || null,
        recruitmentRole: candidate.recruitmentRole
          || inboundContext.vacancy.role
          || inboundContext.vacancy.title
          || null
      }
    : candidate;
  if (typeof candidate?.id !== 'string' || !candidate.id.trim()) {
    throw new ConversationTurnInputBuildError([{
      code: 'custom',
      path: ['candidate', 'id'],
      message: 'candidate.id must be loaded before entering the functional core'
    }]);
  }
  const recentMessages = await prisma.message.findMany({
    where: { candidateId: candidate.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      direction: true,
      body: true,
      rawPayload: true,
      createdAt: true
    }
  });
  const historyMessages = mapHistory(recentMessages);
  const lastBotQuestion = [...historyMessages]
    .reverse()
    .find((item) => item.role === 'assistant' && item.text.includes('?'))?.text ?? null;
  const lastBotReplyIdentity = outboundIdentity(
    recentMessages.find((item) => item.direction === 'OUTBOUND')
  );
  const interpretation = mapInterpretation(message, lastBotQuestion);
  const currentFacts = interpretedRecruitmentFacts(interpretation);
  const candidateForPending = {
    ...effectiveCandidate,
    recruitmentCity: effectiveCandidate.recruitmentCity || currentFacts.recruitmentCity || null,
    recruitmentRole: effectiveCandidate.recruitmentRole || currentFacts.recruitmentRole || null
  };
  const attachments = currentAttachments(message);
  const pendingFields = deriveCandidatePendingFields(candidateForPending)
    .filter((field) => field !== 'cv' || !turnBringsProcessedCv(attachments));

  const mappedInput = {
    vacancy: vacancySnapshot(effectiveCandidate.vacancy || inboundContext.vacancy),
    attribution: inboundContext.attribution,
    turn: {
      id: messageId,
      receivedAt: isoDate(message.timestamp, new Date().toISOString()),
      rawText: message.isSystemAction === true
        ? '[SYSTEM_EVENT]'
        : (typeof message.text === 'string' ? message.text : ''),
      messageType: normalizedMessageType(message.type)
    },
    candidate: {
      id: candidate.id,
      facts: buildCandidateFacts(candidateForPending, interpretation),
      updatedAt: isoDate(candidate.updatedAt)
    },
    history: {
      messages: historyMessages,
      lastBotQuestion,
      lastBotReplyIdentity
    },
    pending: {
      fields: pendingFields,
      actions: []
    },
    execution: {
      mayReply: true,
      mayPersistCandidate: true,
      maySendOutbound: true
    },
    attachments: {
      current: attachments,
      items: attachmentItems(attachments),
      hasCv: turnBringsProcessedCv(attachments)
    },
    ...(interpretation ? { interpretation } : {})
  };

  const parsed = await ConversationTurnInputSchema.safeParseAsync(mappedInput);
  if (!parsed.success) throw new ConversationTurnInputBuildError(parsed.error.issues);
  return parsed.data;
}

export default buildConversationTurnInput;
