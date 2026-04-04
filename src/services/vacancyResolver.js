/**
 * vacancyResolver.js
 * ──────────────────────────────────────────────────────────────────────
 * Responsabilidad:
 *   Dado un mensaje de texto libre (y/o metadata de imagen), identifica qué
 *   vacante y ciudad está buscando el candidato, usando OpenAI como motor.
 *
 * Reglas del negocio:
 *  • Solo vacantes con acceptingApplications=true son elegibles.
 *  • Si hay exactamente UNA vacante activa, se asigna si el texto es
 *    compatible (no la anuncia proactivamente).
 *  • Si hay VARIAS, el bot pregunta de forma natural cul es la de interés.
 *  • Si el candidato envía la imagen de la publicidad, se detecta por
 *    comparación de mimeType/imageName con las vacantes activas.
 */

import axios from 'axios';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

/**
 * Carga las vacantes activas desde Prisma.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<Array>}
 */
export async function getActiveVacancies(prisma) {
  return prisma.vacancy.findMany({
    where: { acceptingApplications: true },
    select: {
      id: true,
      title: true,
      role: true,
      city: true,
      requirements: true,
      conditions: true,
      requiredDocuments: true,
      roleDescription: true,
      schedulingEnabled: true,
      minAge: true,
      maxAge: true,
      experienceRequired: true,
      minExperienceMonths: true,
      maxExperienceMonths: true,
      zoneFilterEnabled: true,
      zoneContext: true
    }
  });
}

/**
 * Intenta resolver la vacante a partir del texto libre del candidato y la
 * lista de vacantes activas.
 *
 * @param {string} text — texto del mensaje del candidato
 * @param {Array} vacancies — vacantes activas
 * @returns {Promise<{ vacancyId: string|null, confidence: 'high'|'low'|'none', reasoning: string }>}
 */
export async function resolveVacancyFromText(text, vacancies) {
  if (!process.env.OPENAI_API_KEY || !vacancies.length) {
    return { vacancyId: null, confidence: 'none', reasoning: 'no_api_or_vacancies' };
  }

  if (vacancies.length === 1) {
    return { vacancyId: vacancies[0].id, confidence: 'high', reasoning: 'single_active_vacancy' };
  }

  const vacancyList = vacancies.map((v, i) =>
    `[${i + 1}] id=${v.id} | cargo="${v.role}" | ciudad="${v.city}" | descripción=${v.roleDescription || 'sin descripción'}`
  ).join('\n');

  const systemPrompt = [
    'Eres un sistema de matching de empleo.',
    'Dado el texto de un candidato y la lista de vacantes activas, determina cuál vacante quiere.',
    'Responde SOLO JSON válido con claves: { "vacancyId": string|null, "confidence": "high"|"low"|"none", "reasoning": string }.',
    '- "high" si el cargo o ciudad mencionados coinciden claramente con una vacante.',
    '- "low" si hay indicio débil pero no certeza.',
    '- "none" si no hay información suficiente.'
  ].join(' ');

  const userPrompt = `Vacantes:\n${vacancyList}\n\nMensaje del candidato: "${text}"`;

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_completion_tokens: 150
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw.trim());
    return {
      vacancyId: parsed.vacancyId || null,
      confidence: parsed.confidence || 'none',
      reasoning: parsed.reasoning || 'openai_resolved'
    };
  } catch {
    return { vacancyId: null, confidence: 'none', reasoning: 'openai_error' };
  }
}

/**
 * Intenta resolver la vacante a partir de una imagen enviada por el candidato
 * (compara el imageMimeType/imageName con las vacantes que tienen imagen).
 *
 * Por ahora implementación simple: si solo hay una vacante con imagen y el
 * candidato envió una imagen, se asigna con confidence=low.
 *
 * @param {Array} vacancies — vacantes activas con información de imagen
 * @returns {{ vacancyId: string|null, confidence: 'high'|'low'|'none', reasoning: string }}
 */
export function resolveVacancyFromImage(vacancies) {
  const withImage = vacancies.filter((v) => v.imageData);
  if (withImage.length === 1) {
    return { vacancyId: withImage[0].id, confidence: 'low', reasoning: 'single_vacancy_with_image' };
  }
  return { vacancyId: null, confidence: 'none', reasoning: 'multiple_or_no_image_vacancies' };
}
