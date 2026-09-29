import axios from 'axios';
import { OPENAI_EXTRACTION_MODEL } from '../../services/openAiModelConfig.js';
import { sanitizeCandidateFieldsForConversation } from '../../services/fieldSanitizer.js';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const ALWAYS_SILENT_FIELDS = new Set(['gender']);
const MAX_ATTACHMENT_TEXT_CHARACTERS = 12_000;
const MAX_TOTAL_DOCUMENT_TEXT_CHARACTERS = 20_000;

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizePendingFields(pendingFields) {
  if (!Array.isArray(pendingFields)) return [];
  return [...new Set(pendingFields
    .filter((field) => typeof field === 'string' && field.trim())
    .map((field) => field.trim()))];
}

function normalizeVacancies(activeVacancies) {
  if (!Array.isArray(activeVacancies)) return [];
  return activeVacancies.flatMap((vacancy) => {
    const source = asRecord(vacancy);
    if (typeof source.id !== 'string' || !source.id.trim()) return [];
    return [{
      id: source.id.trim(),
      role: typeof source.role === 'string' ? source.role.trim() : '',
      title: typeof source.title === 'string' ? source.title.trim() : '',
      city: typeof source.city === 'string' ? source.city.trim() : ''
    }];
  });
}

function attachmentItems(value) {
  if (Array.isArray(value)) return value;
  const container = asRecord(value);
  return Array.isArray(container.current) ? container.current : [];
}

function documentEvidence(attachments) {
  let remainingCharacters = MAX_TOTAL_DOCUMENT_TEXT_CHARACTERS;
  const sections = [];
  for (const attachment of attachmentItems(attachments)) {
    const source = asRecord(attachment);
    if (remainingCharacters <= 0) break;
    if (typeof source.extractedText !== 'string') continue;
    const extractedText = source.extractedText.trim();
    if (!extractedText) continue;
    const boundedText = extractedText.slice(
      0,
      Math.min(MAX_ATTACHMENT_TEXT_CHARACTERS, remainingCharacters)
    );
    remainingCharacters -= boundedText.length;
    sections.push(`[Contenido del Documento Adjunto: ${boundedText}]`);
  }
  return sections;
}

function candidateEvidence(text, attachments) {
  const rawText = typeof text === 'string' ? text.trim() : '';
  return [rawText, ...documentEvidence(attachments)].filter(Boolean).join('\n\n');
}

function normalizeComparable(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function mapIntent(value) {
  const intent = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (['PROVIDE_DATA', 'REQUEST_MISSING_DATA', 'CONTINUE_FLOW'].includes(intent)) {
    return 'PROVIDE_CANDIDATE_DATA';
  }
  if (['PROVIDE_CORRECTION', 'CONFIRM_CORRECTION'].includes(intent)) {
    return 'CORRECT_CANDIDATE_DATA';
  }
  return intent || 'CONTINUE_APPLICATION';
}

function parseJsonContent(response) {
  const content = response?.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return {};
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return {};
  }
}

function buildSystemPrompt({ activeVacancies, candidateCity, candidateSummary }) {
  return `Eres el extractor semántico de Lórren, una asistente de selección de LoginPro.
Devuelve exclusivamente un objeto JSON válido. No redactes una respuesta conversacional.

CATÁLOGO DE VACANTES ACTIVAS (fuente de verdad):
${JSON.stringify(activeVacancies)}

CIUDAD CONOCIDA DEL CANDIDATO:
${JSON.stringify(candidateCity || null)}

RESUMEN CONOCIDO DEL CANDIDATO:
${JSON.stringify(candidateSummary)}

REGLAS OBLIGATORIAS PARA vacancyId:
1. Interpreta semánticamente el cargo mencionado. Ejemplo: "bodega", "cargar camiones" o "cargue" puede corresponder a "Cargue y Descargue".
2. Debes cruzar SIEMPRE cargo Y ciudad. Nunca asocies una vacante usando solamente el cargo.
3. Usa primero la ciudad mencionada en el mensaje y, si no aparece, candidateCity.
4. Solo si existe una coincidencia ÚNICA de rol y ciudad, devuelve el id exacto del catálogo en vacancyId.
5. Si falta la ciudad, no coincide con la ciudad de la vacante, hay varias coincidencias o existe cualquier ambigüedad, devuelve vacancyId: null.
6. Aunque vacancyId sea null, devuelve roleHint y cityHint con lo comprendido. Usa null cuando uno de esos datos no esté disponible.
7. Nunca inventes ids, ciudades, cargos ni datos del candidato.

Además puedes extraer datos del candidato únicamente cuando estén respaldados por el mensaje. No preguntes ni infieras género solo por el nombre.

REGLAS PARA DOCUMENTOS ADJUNTOS:
1. Si aparece un bloque [Contenido del Documento Adjunto: ...], úsalo como fuente de verdad principal para extraer los campos pendientes del perfil (por ejemplo experiencia, edad y ciudad).
2. No inventes datos ausentes ni conviertas información de terceros en datos del candidato.
3. El documento nunca demuestra aceptación legal, consentimiento ni intención de postularse; esos datos requieren evidencia explícita del mensaje del candidato.
4. Si el mensaje actual corrige explícitamente un dato del documento, conserva la corrección más reciente.

Formato exacto esperado:
{
  "intent": "string",
  "vacancyId": "string o null",
  "roleHint": "string o null",
  "cityHint": "string o null",
  "fields": {},
  "fieldEvidence": {},
  "turnType": "string o null"
}`;
}

function validatedVacancyId(parsedVacancyId, cityHint, candidateCity, activeVacancies) {
  if (typeof parsedVacancyId !== 'string' || !parsedVacancyId.trim()) return null;
  const selected = activeVacancies.find((vacancy) => vacancy.id === parsedVacancyId.trim());
  if (!selected) return null;
  const effectiveCity = normalizeComparable(cityHint || candidateCity);
  if (!effectiveCity || effectiveCity !== normalizeComparable(selected.city)) return null;
  return selected.id;
}

/**
 * Extracts candidate-owned data and resolves an organic vacancy only when
 * semantic role matching and city matching identify one catalog entry.
 */
export async function extractCandidateData(text, pendingFields, context = {}, dependencies = {}) {
  const rawText = candidateEvidence(text, context.attachments);
  const pending = normalizePendingFields(pendingFields);
  if (!rawText || pending.length === 0) return null;

  const activeVacancies = normalizeVacancies(context.activeVacancies);
  const candidateSummary = asRecord(context.candidateSummary);
  const candidateCity = typeof context.candidateCity === 'string' && context.candidateCity.trim()
    ? context.candidateCity.trim()
    : null;
  const apiKey = dependencies.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const httpClient = dependencies.httpClient ?? axios;
  const model = dependencies.model ?? OPENAI_EXTRACTION_MODEL;
  const requestBody = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({ activeVacancies, candidateCity, candidateSummary })
      },
      {
        role: 'user',
        content: JSON.stringify({ text: rawText, pendingFields: pending })
      }
    ],
    max_completion_tokens: 500
  };

  try {
    const response = await httpClient.post(OPENAI_CHAT_COMPLETIONS_URL, requestBody, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    const parsed = parseJsonContent(response);
    const sanitized = sanitizeCandidateFieldsForConversation({
      fields: asRecord(parsed.fields),
      evidence: asRecord(parsed.fieldEvidence),
      text: rawText,
      context: { pendingFields: pending },
      turnType: parsed.turnType
    });
    const allowed = new Set([...pending, ...ALWAYS_SILENT_FIELDS]);
    const extractedFields = Object.fromEntries(
      Object.entries(sanitized.fields).filter(([field, value]) => (
        allowed.has(field) && value !== undefined && value !== null && value !== ''
      ))
    );
    const vacancyId = validatedVacancyId(
      parsed.vacancyId,
      parsed.cityHint,
      candidateCity,
      activeVacancies
    );
    if (vacancyId) extractedFields.vacancyId = vacancyId;

    const detectedFields = {};
    if (typeof parsed.roleHint === 'string' && parsed.roleHint.trim()) {
      detectedFields.roleHint = parsed.roleHint.trim();
    }
    if (typeof parsed.cityHint === 'string' && parsed.cityHint.trim()) {
      detectedFields.cityHint = parsed.cityHint.trim();
    }

    return {
      intent: mapIntent(parsed.intent),
      ...(Object.keys(extractedFields).length ? { extractedFields } : {}),
      ...(Object.keys(detectedFields).length ? { detectedFields } : {})
    };
  } catch {
    // La extracción es auxiliar: el núcleo funcional preguntará lo faltante.
    return null;
  }
}

export default Object.freeze({ extractCandidateData });
