import { executeReplayTurn } from '../conversation-replay/replayHarness.js';

export function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => row?.[key] === value);
}

function inboundBody(message = {}) {
  return message.text?.body
    || message.interactive?.button_reply?.title
    || message.interactive?.list_reply?.title
    || message.body
    || '';
}

export function createConsentGateHarness({ candidate: seed = {}, vacancy: vacancySeed = {} } = {}) {
  let candidate = {
    id: 'candidate-consent-replay',
    phone: '573000000002',
    currentStep: 'AWAITING_DATA_CONSENT',
    dataConsentStatus: 'PENDING',
    updatedAt: '2026-07-14T15:00:00.000Z',
    ...structuredClone(seed)
  };
  const vacancy = {
    id: 'vacancy-consent-replay',
    title: 'Vacante de prueba',
    role: 'Cargo de prueba',
    city: 'Ciudad de prueba',
    isActive: true,
    acceptingApplications: true,
    ...structuredClone(vacancySeed)
  };
  const sent = [];
  const decisions = [];

  async function run(message = {}) {
    const replay = await executeReplayTurn({
      id: message.id || `consent-turn-${decisions.length + 1}`,
      executionContext: { now: '2026-07-14T15:00:00.000Z' },
      initialState: { candidate, vacancy, pendingFields: ['dataConsent'] },
      inbound: {
        messageId: message.id || `consent-turn-${decisions.length + 1}`,
        type: ['interactive', 'button'].includes(message.type) ? 'text' : (message.type || 'text'),
        body: inboundBody(message)
      }
    });
    decisions.push(replay.decision);
    candidate = {
      ...candidate,
      ...replay.decision.mutations.fieldsToPersist,
      ...(replay.decision.mutations.nextStep ? { currentStep: replay.decision.mutations.nextStep } : {})
    };
    if (replay.decision.reply) sent.push(structuredClone(replay.decision.reply));
    return replay;
  }

  return {
    prisma: null,
    messages: [],
    events: [],
    sent,
    transactions: [],
    decisions,
    run,
    getCandidate: () => structuredClone(candidate)
  };
}
