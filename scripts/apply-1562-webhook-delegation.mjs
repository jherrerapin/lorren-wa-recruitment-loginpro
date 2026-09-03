import fs from 'node:fs';

const path = 'src/routes/webhook.js';
let source = fs.readFileSync(path, 'utf8');

const importNeedle = "import { buildContextualReply, deriveAttachmentDecision, shouldEscalateHumanReview } from '../services/contextualReply.js';";
const importReplacement = `${importNeedle}\nimport { deliverAutomaticOutboundText } from '../services/automaticOutboundDeliveryService.js';`;
if (!source.includes(importNeedle)) throw new Error('No se encontró import contextualReply esperado');
if (!source.includes("../services/automaticOutboundDeliveryService.js")) {
  source = source.replace(importNeedle, importReplacement);
}

const oldTail = `  await sleep(getNaturalDelayMs(inboundText, finalBody));
  try {
    await sendTextMessage(to, finalBody);
  } catch (error) {
    console.error('[BOT_SEND_ERROR]', JSON.stringify({ candidateId, error: error?.message?.slice(0, 200) }));
    throw error;
  }
  await saveOutboundMessage(prisma, candidateId, finalBody, cleanedPayload);
  await scheduleReminderForCandidate(prisma, candidateId);`;

const newTail = `  let delivery;
  try {
    delivery = await deliverAutomaticOutboundText(prisma, {
      candidateId,
      to,
      body: finalBody,
      rawPayload: cleanedPayload
    }, {
      sendText: sendTextMessage,
      beforeSend: () => sleep(getNaturalDelayMs(inboundText, finalBody))
    });
  } catch (error) {
    console.error('[BOT_SEND_ERROR]', JSON.stringify({ candidateId, error: error?.message?.slice(0, 200) }));
    throw error;
  }
  if (delivery.suppressed) {
    console.info('[BOT_REPLY_DUPLICATE_SUPPRESSED]', JSON.stringify({
      candidateId,
      reason: delivery.reason,
      duplicateMessageId: delivery.duplicateMessageId || null
    }));
    return;
  }
  await scheduleReminderForCandidate(prisma, candidateId);`;

if (!source.includes(oldTail)) throw new Error('No se encontró bloque de transporte automático esperado');
source = source.replace(oldTail, newTail);
fs.writeFileSync(path, source);
