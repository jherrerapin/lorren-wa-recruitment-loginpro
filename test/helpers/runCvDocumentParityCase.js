import { executeReplayTurn } from '../conversation-replay/replayHarness.js';
import { baseVacancies } from '../fixtures/conversationCases.js';

const mode = String(process.argv[2] || 'functional-core');
const vacancy = structuredClone(baseVacancies.find((item) => item.id === 'vac-post'));
const result = await executeReplayTurn({
  id: 'cv-document-parity',
  candidate: {
    id: 'candidate-cv-parity',
    phone: '573001117777',
    currentStep: 'ASK_CV',
    dataConsentStatus: 'ACCEPTED',
    vacancyId: vacancy.id,
    updatedAt: '2026-07-27T10:00:00.000Z'
  },
  vacancy,
  inbound: {
    messageId: 'wamid-cv-parity',
    type: 'document',
    attachment: {
      id: 'media-cv-parity',
      mime_type: 'application/pdf',
      filename: 'hoja-de-vida.pdf',
      extractedText: 'Hoja de vida sintética para pruebas.',
      status: 'processed'
    }
  }
});

console.log(`__LORREN_CV_PARITY__${JSON.stringify({
  version: 2,
  mode,
  input: result.input,
  decision: result.decision
})}`);
