import axios from 'axios';
import { OPENAI_EXTRACTION_MODEL } from './openAiModelConfig.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const TICKET_SCHEMA = {
  name: 'lorren_support_ticket_interpretation',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'title',
      'module',
      'type',
      'summary',
      'currentBehavior',
      'expectedBehavior',
      'suggestedScope',
      'confidence',
      'suggestedPriority'
    ],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 140 },
      module: { type: 'string', enum: ['RECLUTAMIENTO', 'DESPACHO', 'ASISTENCIA', 'GESTION_TIEMPO', 'FACTURACION', 'OTRO'] },
      type: { type: 'string', enum: ['ERROR', 'MEJORA', 'UX', 'SOLICITUD', 'CONSULTA'] },
      summary: { type: 'string', minLength: 1, maxLength: 1200 },
      currentBehavior: { type: ['string', 'null'], maxLength: 1200 },
      expectedBehavior: { type: ['string', 'null'], maxLength: 1200 },
      suggestedScope: { type: ['string', 'null'], maxLength: 1200 },
      confidence: { type: 'string', enum: ['ALTA', 'MEDIA', 'BAJA'] },
      suggestedPriority: { type: 'string', enum: ['BAJA', 'NORMAL', 'ALTA', 'URGENTE'] }
    }
  }
};

function parseOutput(data = {}) {
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

function fallbackInterpretation(text, reason = 'manual_review_required') {
  const clean = String(text || '').trim();
  return {
    title: clean.slice(0, 120) || 'Ticket sin título',
    module: 'OTRO',
    type: 'SOLICITUD',
    summary: clean || 'Sin descripción.',
    currentBehavior: null,
    expectedBehavior: null,
    suggestedScope: null,
    confidence: 'BAJA',
    suggestedPriority: 'NORMAL',
    aiStatus: reason
  };
}

async function reportUsage(options, model, usage) {
  if (typeof options?.onUsage !== 'function' || !usage) return;
  try {
    await options.onUsage({ source: 'SUPPORT_TICKET_INTERPRETATION', model, usage });
  } catch {
    // La telemetría nunca debe bloquear la creación del ticket.
  }
}

export async function interpretLorrenSupportTicket(text, options = {}) {
  const originalText = String(text || '').trim();
  if (!originalText) return fallbackInterpretation('', 'empty_text');
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return fallbackInterpretation(originalText, 'openai_disabled');

  const model = options.model || OPENAI_EXTRACTION_MODEL;
  const http = options.httpClient || axios;
  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: [
            'Eres el analista interno de tickets de Lórren.',
            'Convierte el mensaje en una especificación breve y fiel para un desarrollador.',
            'No inventes requisitos, causas, archivos, endpoints ni soluciones.',
            'Conserva la intención del usuario y distingue claramente lo observado de lo esperado.',
            'Si falta información, usa null donde corresponda y confidence BAJA o MEDIA.',
            'La prioridad es solo una sugerencia; URGENTE únicamente cuando el texto describe una caída, bloqueo general, pérdida/corrupción de datos o riesgo operativo inmediato.'
          ].join(' ')
        }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify({ originalText: originalText.slice(0, 6000) }) }]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: TICKET_SCHEMA.name,
        strict: TICKET_SCHEMA.strict,
        schema: TICKET_SCHEMA.schema
      }
    }
  };

  try {
    const response = await http.post(OPENAI_RESPONSES_URL, payload, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    await reportUsage(options, model, response?.data?.usage);
    const parsed = parseOutput(response.data);
    if (!parsed) return fallbackInterpretation(originalText, 'openai_unparsed');
    return { ...parsed, aiStatus: 'interpreted', aiModel: model };
  } catch (error) {
    console.error('[LORREN_SUPPORT_TICKET_AI_FAILED]', { code: error?.response?.status || error?.code || error?.message || 'unknown' });
    return fallbackInterpretation(originalText, 'openai_failed');
  }
}
