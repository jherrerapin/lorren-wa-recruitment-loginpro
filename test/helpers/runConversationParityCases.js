import { conversationCases } from '../fixtures/conversationCases.js';
import { conversationParityCases } from '../fixtures/conversationParityCases.js';
import { executeReplayTurn } from '../conversation-replay/replayHarness.js';

const caseIds = JSON.parse(process.argv[3] || '[]');

if (Array.isArray(caseIds) && caseIds.length) {
  const byId = new Map([...conversationCases, ...conversationParityCases].map((item) => [item.id, item]));
  const snapshots = [];
  for (const caseId of caseIds) {
    const conversationCase = byId.get(caseId);
    if (!conversationCase) throw new Error(`Caso de conversación no encontrado: ${caseId}`);
    const rawText = String(conversationCase.steps?.[0] || '');
    const result = await executeReplayTurn({
      id: caseId,
      candidate: conversationCase.candidate || {},
      vacancy: conversationCase.vacancy || null,
      rawText,
      inbound: { messageId: `parity-${caseId}`, type: 'text', body: rawText },
      interpretation: conversationCase.interpretation || {}
    });
    snapshots.push({ caseId, input: result.input, decision: result.decision });
  }
  console.log(`__LORREN_PARITY__${JSON.stringify(snapshots)}`);
}
