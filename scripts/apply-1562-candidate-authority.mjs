import fs from 'node:fs';

const statePath = 'src/services/candidateStateService.js';
const deliveryPath = 'src/services/automaticOutboundDeliveryService.js';

let state = fs.readFileSync(statePath, 'utf8');
const anchor = `export async function completeSupervisorReviewAfterDelivery(client, input = {}) {`;
if (!state.includes(anchor)) throw new Error('candidateStateService anchor missing');
if (!state.includes('recordCandidateAutomaticOutboundSent')) {
  const addition = `export async function recordCandidateAutomaticOutboundSent(client, input = {}) {\n  const candidateClient = requireCandidateClient(client);\n  const candidateId = requireCandidateId(input.candidateId);\n  const sentAtInput = input.sentAt === undefined ? new Date() : input.sentAt;\n  const sentAt = requireValidDate(sentAtInput, 'candidate_automatic_outbound_sent_at');\n\n  const result = await candidateClient.candidate.updateMany({\n    where: {\n      id: candidateId,\n      OR: [\n        { lastOutboundAt: null },\n        { lastOutboundAt: { lt: sentAt } }\n      ]\n    },\n    data: { lastOutboundAt: sentAt }\n  });\n\n  const candidate = await candidateClient.candidate.findUnique({\n    where: { id: candidateId }\n  });\n\n  return {\n    count: Number(result?.count || 0),\n    candidate,\n    sentAt\n  };\n}\n\n`;
  state = state.replace(anchor, `${addition}${anchor}`);
}
fs.writeFileSync(statePath, state);

let delivery = fs.readFileSync(deliveryPath, 'utf8');
const importAnchor = `import {\n  ReplySimilarityThreshold,\n  isSubstantiallySimilarReply,\n  normalizeReplySignature\n} from './replySimilarityPolicy.js';`;
const importReplacement = `${importAnchor}\nimport { recordCandidateAutomaticOutboundSent } from './candidateStateService.js';`;
if (!delivery.includes(importAnchor)) throw new Error('automatic delivery import anchor missing');
if (!delivery.includes('recordCandidateAutomaticOutboundSent')) {
  delivery = delivery.replace(importAnchor, importReplacement);
}

delivery = delivery.replace(
  `    || typeof prisma?.message?.update !== 'function'\n    || typeof prisma?.candidate?.update !== 'function'\n`,
  `    || typeof prisma?.message?.update !== 'function'\n    || typeof prisma?.candidate?.updateMany !== 'function'\n    || typeof prisma?.candidate?.findUnique !== 'function'\n`
);

const finalizeOld = `    await prisma.$transaction(async (tx) => {\n      await updateOutboundConversationDelivery(tx, {\n        messageId: claim.messageId,\n        state: 'SENT',\n        occurredAt: sentAt,\n        providerMessageId: waMessageId\n      });\n      await tx.candidate.update({\n        where: { id: candidateId },\n        data: { lastOutboundAt: sentAt }\n      });\n    });`;
const finalizeNew = `    await prisma.$transaction(async (tx) => {\n      const candidateTransition = await recordCandidateAutomaticOutboundSent(tx, {\n        candidateId,\n        sentAt\n      });\n      await updateOutboundConversationDelivery(tx, {\n        messageId: claim.messageId,\n        state: 'SENT',\n        occurredAt: sentAt,\n        providerMessageId: waMessageId,\n        candidateStateCount: candidateTransition.count\n      });\n    });`;
if (!delivery.includes(finalizeOld)) throw new Error('automatic delivery finalize block missing');
delivery = delivery.replace(finalizeOld, finalizeNew);
fs.writeFileSync(deliveryPath, delivery);
