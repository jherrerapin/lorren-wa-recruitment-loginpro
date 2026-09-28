import { ConversationTurnInputSchema } from '../../src/core/contracts/ConversationTurnInputSchema.js';
import { buildConversationTurnInput } from '../../src/core/middlewares/buildConversationTurnInput.js';
import { calculateConversationDecision } from '../../src/core/engine/calculateConversationDecision.js';

const DEFAULT_NOW = '2026-07-14T15:00:00.000Z';
const DEFAULT_PHONE = '573000000001';

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeVacancy(value) {
  const vacancy = asRecord(value);
  const id = vacancy.id || vacancy.vacancyId;
  if (!id) return null;
  return {
    ...vacancy,
    id,
    title: String(vacancy.title || vacancy.role || 'Vacante de prueba'),
    role: String(vacancy.role || vacancy.title || 'Vacante de prueba'),
    city: String(vacancy.city || 'Ciudad de prueba'),
    isActive: vacancy.isActive !== false,
    acceptingApplications: vacancy.acceptingApplications !== false
  };
}

function normalizeCandidate(fixture, vacancy, now) {
  const source = asRecord(fixture.initialState?.candidate || fixture.candidate);
  return {
    ...source,
    id: String(source.id || source.candidateId || `candidate-${fixture.id || 'replay'}`),
    phone: String(source.phone || fixture.inbound?.from || DEFAULT_PHONE),
    vacancyId: source.vacancyId || vacancy?.id || null,
    vacancy,
    updatedAt: source.updatedAt || source.createdAt || now
  };
}

function normalizeInterpretation(fixture) {
  const explicit = asRecord(fixture.interpretation);
  const aiResult = asRecord(fixture.providerStubs?.aiResult);
  const providedFields = asRecord(explicit.providedFields || aiResult.parsedFields || aiResult.fields);
  const interpretation = {
    ...(typeof explicit.intent === 'string' ? { intent: explicit.intent } : {}),
    ...(!explicit.intent && typeof aiResult.intent === 'string' ? { intent: aiResult.intent } : {}),
    ...(Object.keys(providedFields).length ? { providedFields } : {})
  };
  return Object.keys(interpretation).length ? interpretation : undefined;
}

function normalizeMedia(inbound) {
  const attachment = asRecord(inbound.attachment);
  if (!['document', 'image', 'audio'].includes(inbound.type)) return undefined;
  return {
    mediaId: String(attachment.mediaId || attachment.providerId || attachment.id || 'media-replay'),
    mimeType: String(attachment.mimeType || attachment.mime_type || 'application/octet-stream'),
    fileName: attachment.fileName || attachment.filename || null,
    extractedText: attachment.extractedText ?? null,
    status: attachment.status || (attachment.extractedText ? 'processed' : 'received')
  };
}

function normalizeHistory(fixture, now) {
  return (Array.isArray(fixture.history) ? fixture.history : []).map((message, index) => ({
    direction: message.direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
    body: String(message.body || message.text || ''),
    createdAt: message.createdAt || new Date(new Date(now).getTime() - (index + 1) * 60_000)
  }));
}

export function createCoreReplayDependencies(fixture) {
  const now = fixture.executionContext?.now || fixture.now || DEFAULT_NOW;
  const vacancy = normalizeVacancy(fixture.initialState?.vacancy || fixture.vacancy);
  const candidate = normalizeCandidate(fixture, vacancy, now);
  const history = normalizeHistory(fixture, now);
  const state = { candidate, history };
  return {
    state,
    prisma: {
      candidate: {
        async findUnique() { return structuredClone(state.candidate); },
        async create() { return structuredClone(state.candidate); }
      },
      message: {
        async findMany() { return structuredClone([...state.history].reverse()); }
      },
      campaign: { async findMany() { return []; } },
      vacancy: { async findMany() { return vacancy ? [structuredClone(vacancy)] : []; } }
    }
  };
}

export async function executeReplayTurn(fixture, options = {}) {
  const dependencies = options.dependencies || createCoreReplayDependencies(fixture);
  const inbound = asRecord(fixture.inbound || fixture.rawMessage);
  const vacancy = normalizeVacancy(fixture.initialState?.vacancy || fixture.vacancy);
  const now = fixture.executionContext?.now || fixture.now || DEFAULT_NOW;
  const media = normalizeMedia(inbound);
  const interpretation = normalizeInterpretation(fixture);
  const builtInput = await buildConversationTurnInput({
    messageId: String(inbound.messageId || inbound.id || `message-${fixture.id || 'replay'}`),
    from: String(inbound.from || dependencies.state.candidate.phone || DEFAULT_PHONE),
    timestamp: inbound.timestamp || now,
    type: inbound.type || 'text',
    text: String(inbound.body ?? inbound.text ?? inbound.caption ?? fixture.rawText ?? ''),
    ...(media ? { media } : {}),
    ...(vacancy ? { resolvedVacancy: vacancy } : {}),
    ...(interpretation ? { interpretation } : {})
  }, { prisma: dependencies.prisma });

  const requestedPending = fixture.initialState?.pendingFields || fixture.pending?.fields;
  const candidateInput = {
    ...builtInput,
    ...(Array.isArray(requestedPending) ? { pending: { fields: [...requestedPending], actions: [] } } : {}),
    execution: {
      ...builtInput.execution,
      mayPersistCandidate: false,
      maySendOutbound: false,
      dryRun: true
    }
  };
  const parsedInput = await ConversationTurnInputSchema.safeParseAsync(candidateInput);
  if (!parsedInput.success) throw parsedInput.error;
  const input = parsedInput.data;
  const decision = await calculateConversationDecision(input);
  return { input, decision };
}

export default executeReplayTurn;
