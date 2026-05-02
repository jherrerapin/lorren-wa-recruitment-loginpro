/**
 * openaiUsageLogger.js
 * ──────────────────────────────────────────────────────────────────────
 * Registra consumo de tokens de OpenAI sin guardar prompts ni respuestas.
 */

import crypto from 'node:crypto';

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readUsage(data = {}) {
  const usage = data?.usage || {};

  return {
    inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    cachedInputTokens: Number(
      usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? 0
    )
  };
}

export async function logOpenAIUsage(prisma, {
  responseData = {},
  modelRequested,
  usageType = 'unknown',
  candidate = null,
  messageId = null,
  privacy = {}
} = {}) {
  if (!prisma?.openAIUsageLog?.create) return null;

  const usage = readUsage(responseData);
  const modelReturned = responseData?.model || null;

  try {
    return await prisma.openAIUsageLog.create({
      data: {
        candidateId: candidate?.id || null,
        messageId: messageId || null,
        phoneHash: sha256(candidate?.phone || null),
        modelRequested: String(modelRequested || modelReturned || 'unknown'),
        modelReturned,
        usageType,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        totalTokens: usage.totalTokens,
        dataSharingEnabled: process.env.OPENAI_DATA_SHARING_ENABLED === 'true',
        privacyMaskingEnabled: privacy.privacyMaskingEnabled !== false,
        sensitiveDataDetected: Boolean(privacy.sensitiveDataDetected),
        redactionSummary: Array.isArray(privacy.redactionSummary) ? privacy.redactionSummary : [],
        openAIResponseId: responseData?.id || null
      }
    });
  } catch (error) {
    console.warn('[OPENAI_USAGE_LOG_ERROR]', {
      usageType,
      modelRequested,
      error: error?.message?.slice(0, 220)
    });
    return null;
  }
}
