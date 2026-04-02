import express from 'express';
import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from '../services/whatsapp.js';
import { fetchMediaMetadata, downloadMedia } from '../services/media.js';
import { tryOpenAIParse } from '../services/aiParser.js';
import { createDebugTrace, inferIntent, sanitizeForRawPayload, splitFieldDecisions, summarizeError } from '../services/debugTrace.js';
import { isCvMimeTypeAllowed, resolveStepAfterDataCompletion, shouldFinalizeAfterCv } from '../services/cvFlow.js';

const FAQ_RESPONSE = 'En este momento estamos recolectando hojas de vida. La entrevista está prevista para el 8 de abril. Por favor mantente pendiente del llamado del equipo de reclutamiento.';

const SALUDO_INICIAL = `Hola, gracias por comunicarte con LoginPro.
Te comparto la información de la vacante disponible:

*Vacante: Auxiliar de Cargue y Descargue*

Estamos en búsqueda de personal para trabajar en Ibagué, en el sector aeropuerto.

*Condiciones del cargo:*
- Pago quincenal
- Disponibilidad para turnos rotativos
- Horas extras
- Contrato por obra labor directamente con la empresa
- Prestaciones de ley
- Debe contar con medio de transporte (moto o bicicleta)
- La entrevista está prevista para el 8 de abril
- Debes estar pendiente del llamado para entrevista

Si estás interesado en continuar, respóndeme y te solicitaré tus datos.`;

const SOLICITAR_DATOS = 'Perfecto. Envíame por favor estos datos para continuar: nombre completo, tipo de documento, número de documento, edad, barrio, si tienes experiencia en el cargo y cuánto tiempo, si tienes restricciones médicas y qué medio de transporte tienes. Puedes enviarlos en un solo mensaje, como te sea más fácil.';
const DESCARTE_MSG = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con uno de los requisitos definidos para esta vacante.';
const CIERRE_NO_INTERES = 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const SOLICITAR_CV = '¡Gracias! Ya tengo tus datos. Por favor adjunta tu hoja de vida en PDF o Word (.doc/.docx) para finalizar tu postulación.';
const RECORDATORIO_CV = 'Para continuar necesito que adjuntes tu hoja de vida en PDF o Word (.doc/.docx). Cuando la envíes, finalizamos tu proceso.';
const MENSAJE_FINAL = 'Tu información y hoja de vida fueron recibidas correctamente. Las entrevistas están previstas para el 8 de abril. Debes estar pendiente del mensaje o llamada del reclutador; por ese medio te confirmarán la hora y el lugar.';
const GUIA_CONTINUAR = 'Puedo ayudarte a continuar con la postulación. Si deseas seguir, envíame tus datos y te voy guiando.';

function normalizeText(text = '') { return text.trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isFAQ(text) { const n = normalizeText(text).toLowerCase(); return /(cu[aá]ndo\s+(empiezan|me llaman|inicia|arranca|se comunican)|para\s+cu[aá]ndo)/i.test(n); }
function isAffirmativeInterest(text) {
  const n = normalizeText(text).toLowerCase(); if (!n) return false;
  const patterns = ['si', 'sí', 'claro', 'listo', 'ok', 'okay', 'dale', 'de una', 'hagámosle', 'vamos', 'estoy interesado', 'estoy interesada', 'me interesa', 'quiero aplicar', 'quiero postularme', 'quiero participar', 'deseo continuar', 'me gustaría postularme', 'quiero seguir', 'continuar'];
  if (patterns.some((p) => n === p || n.includes(p))) return true;
  return /(quiero|deseo|me gustar[ií]a|vamos|listo|claro).*(aplicar|postular|continuar|seguir|participar)/i.test(n);
}
function isNegativeInterest(text) { const n = normalizeText(text).toLowerCase(); return /^(no+|nop+|negativo)$|no gracias|no me interesa|no estoy interesad|no deseo|paso|ya no|prefiero no/i.test(n); }
function shouldRejectByRequirements(text, parsed = {}) {
  const n = normalizeText(text).toLowerCase();
  if (parsed.age && (parsed.age < 18 || parsed.age > 50)) return true;
  if (/no\s+tengo\s+documento\s+vigente|documento\s+vencido|sin\s+documento\s+vigente/.test(n)) return true;
  if (/(soy\s+extranjero|soy\s+venezolan|extranjera?)/.test(n) && /(no\s+tengo\s+ppt|sin\s+ppt|ppt\s+vencido)/.test(n)) return true;
  return false;
}
function capitalizeWords(str) { return str.toLowerCase().replace(/(^|\s)(\S)/g, (_m, space, char) => space + char.toUpperCase()); }

function parseNaturalData(text) {
  const result = {}; let remaining = text;
  const docRegex = /\b(c\.?\s*c\.?|c[ée]dula|t\.?\s*i\.?|tarjeta\s+de\s+identidad|c\.?\s*e\.?|c[ée]dula\s+de\s+extranjer[íi]a|pasaporte|ppt)\s*(?:es|:|\-|#|\.|\s)\s*(\d{6,12})\b/i;
  const docMatch = remaining.match(docRegex);
  if (docMatch) {
    const tipoRaw = docMatch[1].toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
    const tipoMap = { cc: 'CC', cedula: 'CC', cédula: 'CC', ti: 'TI', tarjetadeidentidad: 'TI', ce: 'CE', ceduladeextranjería: 'CE', ceduladeextranjeria: 'CE', pasaporte: 'Pasaporte', ppt: 'PPT' };
    result.documentType = tipoMap[tipoRaw] || tipoRaw.toUpperCase(); result.documentNumber = docMatch[2]; remaining = remaining.replace(docMatch[0], ' ');
  }
  if (!result.documentNumber) { const docNum = remaining.match(/(?:^|\s)(\d{7,12})(?:\s|$)/); if (docNum) { result.documentNumber = docNum[1]; remaining = remaining.replace(docNum[1], ' '); } }
  const ageMatch = remaining.match(/\b(?:edad\s*[:\-]?\s*|tengo\s+)?(\d{1,2})\s*(?:a[ñn]os?)?\b/i);
  if (ageMatch) { const age = parseInt(ageMatch[1], 10); if (age >= 14 && age <= 99) { result.age = age; remaining = remaining.replace(ageMatch[0], ' '); } }
  const barrioMatch = remaining.match(/\b(?:barrio|zona|sector|localidad|vereda)\s*[:\-]?\s*([^,.\n]{2,60})/i);
  if (barrioMatch) { result.neighborhood = capitalizeWords(barrioMatch[1].trim()); remaining = remaining.replace(barrioMatch[0], ' '); }
  const negativeExperience = /\b(no\s+tengo\s+experiencia|sin\s+experiencia)\b/i.test(remaining);
  const positiveExperience = /\b(s[ií],?\s*tengo\s+experiencia|tengo\s+experiencia|cuento\s+con\s+experiencia|experiencia\s*[:\-]?\s*s[ií])\b/i.test(remaining);
  if (negativeExperience) result.experienceInfo = 'No'; else if (positiveExperience) result.experienceInfo = 'Sí';
  const expTime = remaining.match(/\b(?:tengo|llevo|cuento\s+con|experiencia\s+de)?\s*(\d+\s*(?:a[ñn]os?|mes(?:es)?|semana(?:s)?))\b/i);
  if (expTime) { result.experienceTime = expTime[1]; result.experienceInfo = 'Sí'; }
  const medicalNegative = /\b(no\s+tengo\s+ninguna\s+restricci[oó]n|no\s+tengo\s+restricciones?\s+m[ée]dicas?|no\s+presento\s+restricciones?\s+m[ée]dicas?|no\s+cuento\s+con\s+restricciones?\s+m[ée]dicas?|ninguna\s+restricci[oó]n\s+m[ée]dica|sin\s+restricciones?\s+m[ée]dicas?)\b/i.test(remaining) || /^(no|ninguna|ninguno)$/i.test(remaining);
  const medicalAffirmative = /\b(s[ií]\s+tengo\s+restricciones?\s+m[ée]dicas?|tengo\s+restricci[oó]n(?:\s+m[ée]dica)?|no\s+puedo\s+cargar|problema\s+de\s+columna|restricci[oó]n\s+en\s+la\s+espalda)\b/i.test(remaining);
  const medicalMatch = remaining.match(/(?:restricciones?\s+m[ée]dicas?\s*[:\-]?\s*)([^,.\n]{2,100})/i);
  if (medicalNegative) result.medicalRestrictions = 'Sin restricciones médicas';
  else if (medicalMatch) { const medicalValue = medicalMatch[1].trim(); result.medicalRestrictions = /^no$/i.test(medicalValue) ? 'Sin restricciones médicas' : capitalizeWords(medicalValue); }
  else if (medicalAffirmative) { const snippet = remaining.match(/(tengo\s+[^,.\n]{5,80}|no\s+puedo\s+[^,.\n]{5,80}|problema\s+de\s+[^,.\n]{3,80})/i); result.medicalRestrictions = snippet ? capitalizeWords(snippet[1].trim()) : 'Sí, reporta restricciones médicas'; }
  const transportMatch = remaining.match(/\b(moto|bicicleta|bici|carro|bus|ninguno|ninguna)\b/i);
  if (transportMatch) result.transportMode = capitalizeWords(transportMatch[1].replace('bici', 'bicicleta'));
  const namePref = text.match(/(?:me\s+llamo|soy|mi\s+nombre\s+es|nombre\s*[:\-]?)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ ]{4,60})/i);
  if (namePref) result.fullName = capitalizeWords(namePref[1].trim());
  else { const first = text.split(/[\n,]/)[0]?.trim() || ''; if (/^[A-ZÁÉÍÓÚÑa-záéíóúñ]+(\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){1,4}$/.test(first)) result.fullName = capitalizeWords(first); }
  return result;
}
function getMissingFields(candidate) { const m = []; if (!candidate.fullName) m.push('nombre completo'); if (!candidate.documentType) m.push('tipo de documento'); if (!candidate.documentNumber) m.push('número de documento'); if (!candidate.age) m.push('edad'); if (!candidate.neighborhood) m.push('barrio'); if (!candidate.experienceInfo) m.push('experiencia en el cargo'); if (!candidate.experienceTime) m.push('tiempo de experiencia'); if (!candidate.medicalRestrictions) m.push('restricciones médicas'); if (!candidate.transportMode) m.push('medio de transporte'); return m; }
function containsCandidateData(text) { return Object.keys(parseNaturalData(text)).length > 0; }
function hasCv(candidate) { return Boolean(candidate?.cvData); }
function getNaturalDelayMs(inputText = '', outputText = '') { if (process.env.NODE_ENV === 'test') return 0; const l = Math.max(normalizeText(inputText).length, normalizeText(outputText).length, 1); return Math.max(1500, Math.min(2500, 1500 + Math.min(1000, Math.round(l * 8)))); }

async function saveInboundMessage(prisma, candidateId, message, body, type) {
  try {
    const created = await prisma.message.create({ data: { candidateId, waMessageId: message.id, direction: MessageDirection.INBOUND, messageType: type, body, rawPayload: sanitizeForRawPayload(message) } });
    return { isNew: true, id: created.id };
  } catch (error) {
    if (String(error?.message || '').includes('Unique constraint')) return { isNew: false, id: null };
    throw error;
  }
}
async function attachDebugTrace(prisma, messageId, debugTrace) {
  if (!messageId) return;
  const current = await prisma.message.findUnique({ where: { id: messageId }, select: { rawPayload: true } });
  await prisma.message.update({ where: { id: messageId }, data: { rawPayload: { ...(current?.rawPayload || {}), debugTrace } } });
}
async function saveOutboundMessage(prisma, candidateId, body) { await prisma.message.create({ data: { candidateId, direction: MessageDirection.OUTBOUND, messageType: MessageType.TEXT, body, rawPayload: { body } } }); }
async function reply(prisma, candidateId, to, body, inboundText = '') { await sleep(getNaturalDelayMs(inboundText, body)); await sendTextMessage(to, body); await saveOutboundMessage(prisma, candidateId, body); }
async function rejectCandidate(prisma, candidateId, from) { await prisma.candidate.update({ where: { id: candidateId }, data: { status: CandidateStatus.RECHAZADO, currentStep: ConversationStep.DONE } }); await reply(prisma, candidateId, from, DESCARTE_MSG); }

async function processText(prisma, candidate, from, text, debugTrace) {
  const cleanText = normalizeText(text);
  const hasDataIntent = containsCandidateData(cleanText);
  debugTrace.openai_intent = inferIntent(cleanText);

  const aiResult = await tryOpenAIParse(cleanText);
  const parsedData = parseNaturalData(cleanText);
  const aiFields = aiResult.parsedFields || {};
  const mergedData = { ...parsedData, ...aiFields };

  debugTrace.openai_used = aiResult.used;
  debugTrace.openai_status = aiResult.status === 'error' ? 'fallback' : aiResult.status;
  debugTrace.openai_model = aiResult.model || debugTrace.openai_model;
  debugTrace.openai_temperature_omitted = typeof aiResult.temperature_omitted === 'boolean'
    ? aiResult.temperature_omitted
    : debugTrace.openai_temperature_omitted;
  if (aiResult.intent) debugTrace.openai_intent = aiResult.intent;
  debugTrace.openai_detected_fields = Object.keys(aiFields).filter((k) => mergedData[k] !== undefined);

  if (aiResult.status === 'error') {
    debugTrace.error_summary = summarizeError(aiResult.error);
    console.warn('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, error: debugTrace.error_summary }));
  } else if (aiResult.status === 'disabled') {
    console.log('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, reason: 'openai_disabled' }));
  }

  if (isFAQ(cleanText)) return reply(prisma, candidate.id, from, FAQ_RESPONSE);
  if (candidate.status === CandidateStatus.RECHAZADO) return reply(prisma, candidate.id, from, DESCARTE_MSG);
  if (candidate.currentStep === ConversationStep.MENU) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
    return reply(prisma, candidate.id, from, SALUDO_INICIAL);
  }
  if (candidate.currentStep === ConversationStep.ASK_CV) return reply(prisma, candidate.id, from, RECORDATORIO_CV);
  if (candidate.currentStep === ConversationStep.DONE) return reply(prisma, candidate.id, from, MENSAJE_FINAL);

  const applyDecisionsAndUpdate = async () => {
    const current = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const decisions = splitFieldDecisions(mergedData, current);
    debugTrace.persisted_fields.push(...decisions.persistedFields);
    debugTrace.rejected_fields.push(...decisions.rejectedFields);
    debugTrace.ignored_low_confidence_fields.push(...decisions.ignoredLowConfidenceFields);
    debugTrace.suspicious_full_name_rejected = decisions.suspiciousFullNameRejected;
    if (decisions.suspiciousFullNameRejected) console.warn('[AI_REJECTED_NAME]', JSON.stringify({ phone: candidate.phone, fullName: mergedData.fullName || null }));
    if (Object.keys(decisions.persistedData).length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: decisions.persistedData });
    }
    return prisma.candidate.findUnique({ where: { id: candidate.id } });
  };

  if (candidate.currentStep === ConversationStep.GREETING_SENT) {
    if (isNegativeInterest(cleanText)) { await reply(prisma, candidate.id, from, CIERRE_NO_INTERES); return; }
    if (isAffirmativeInterest(cleanText) || hasDataIntent) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      if (hasDataIntent) {
        if (shouldRejectByRequirements(cleanText, mergedData)) return rejectCandidate(prisma, candidate.id, from);
        const updated = await applyDecisionsAndUpdate();
        const missing = getMissingFields(updated);
        if (!missing.length) {
          if (resolveStepAfterDataCompletion({ hasCv: hasCv(updated) }) === ConversationStep.DONE) {
            await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
            return reply(prisma, candidate.id, from, MENSAJE_FINAL);
          }
          await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
          return reply(prisma, candidate.id, from, SOLICITAR_CV);
        }
        return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`);
      }
      return reply(prisma, candidate.id, from, SOLICITAR_DATOS);
    }

    if (shouldRejectByRequirements(cleanText, mergedData)) return rejectCandidate(prisma, candidate.id, from);
    if (Object.keys(mergedData).length >= 1) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const updated = await applyDecisionsAndUpdate();
      const missing = getMissingFields(updated);
      if (!missing.length) {
        if (resolveStepAfterDataCompletion({ hasCv: hasCv(updated) }) === ConversationStep.DONE) {
          await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
          return reply(prisma, candidate.id, from, MENSAJE_FINAL);
        }
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
        return reply(prisma, candidate.id, from, SOLICITAR_CV);
      }
      return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`);
    }
    return reply(prisma, candidate.id, from, GUIA_CONTINUAR);
  }

  if (candidate.currentStep === ConversationStep.COLLECTING_DATA) {
    if (shouldRejectByRequirements(cleanText, mergedData)) return rejectCandidate(prisma, candidate.id, from);
    const updated = await applyDecisionsAndUpdate();
    const missing = getMissingFields(updated);
    if (!missing.length) {
      if (resolveStepAfterDataCompletion({ hasCv: hasCv(updated) }) === ConversationStep.DONE) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
        return reply(prisma, candidate.id, from, MENSAJE_FINAL);
      }
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
      return reply(prisma, candidate.id, from, SOLICITAR_CV);
    }
    return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`);
  }
}

export function webhookRouter(prisma) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  });

  router.post('/', async (req, res, next) => {
    try {
      const messages = extractMessages(req.body);
      if (!messages.length) return res.sendStatus(200);

      for (const message of messages) {
        const from = message.from;
        if (!from) continue;

        const candidate = await prisma.candidate.upsert({ where: { phone: from }, update: {}, create: { phone: from } });

        if (message.type === 'text') {
          const body = message.text?.body || '';
          const inbound = await saveInboundMessage(prisma, candidate.id, message, body, MessageType.TEXT);
          if (!inbound.isNew) continue;

          const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          const debugTrace = createDebugTrace({ phone: from, currentStepBefore: freshCandidate.currentStep });
          try {
            await processText(prisma, freshCandidate, from, body, debugTrace);
          } catch (error) {
            debugTrace.error_summary = summarizeError(error);
            console.error('[AI_TRACE]', JSON.stringify({ phone: from, error: debugTrace.error_summary }));
            throw error;
          } finally {
            const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id }, select: { currentStep: true } });
            debugTrace.currentStep_after = updatedCandidate?.currentStep || debugTrace.currentStep_before;
            console.log('[AI_TRACE]', JSON.stringify(debugTrace));
            await attachDebugTrace(prisma, inbound.id, debugTrace);
          }
          continue;
        }

        const inbound = await saveInboundMessage(prisma, candidate.id, message, message.document?.filename || '', MessageType.DOCUMENT);
        if (!inbound.isNew) continue;

        const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        const debugTrace = createDebugTrace({ phone: from, currentStepBefore: freshCandidate.currentStep });
        debugTrace.cv_detected = message.type === 'document';

        try {
          if (message.type === 'document') {
            const mimeType = message.document?.mime_type || '';
            if (!isCvMimeTypeAllowed(mimeType)) {
              debugTrace.cv_invalid_mime = true;
              console.warn('[CV_ERROR]', JSON.stringify({ phone: from, mimeType, reason: 'invalid_mime' }));
              await reply(prisma, candidate.id, from, 'Recibí tu archivo, pero por favor envíalo como PDF o Word (.doc/.docx).');
            } else {
              try {
                const metadata = await fetchMediaMetadata(message.document.id);
                const cvBuffer = await downloadMedia(metadata.url);
                await prisma.candidate.update({ where: { id: candidate.id }, data: { cvData: cvBuffer, cvMimeType: mimeType, cvOriginalName: message.document?.filename || 'hoja_de_vida' } });
                debugTrace.cv_saved = true;
                console.log('[CV_TRACE]', JSON.stringify({ phone: from, filename: message.document?.filename || null, mimeType }));
                const afterCvSave = await prisma.candidate.findUnique({ where: { id: candidate.id } });
                const missing = getMissingFields(afterCvSave);
                if (shouldFinalizeAfterCv({ missingFields: missing })) {
                  await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
                  await reply(prisma, candidate.id, from, MENSAJE_FINAL);
                } else {
                  if (afterCvSave.currentStep !== ConversationStep.COLLECTING_DATA) {
                    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
                  }
                  await reply(prisma, candidate.id, from, `Hoja de vida recibida. Aún necesito estos datos para completar tu registro: ${missing.join(', ')}`);
                }
              } catch (error) {
                debugTrace.cv_download_failed = true;
                debugTrace.error_summary = summarizeError(error);
                console.error('[CV_ERROR]', JSON.stringify({ phone: from, error: debugTrace.error_summary }));
                await reply(prisma, candidate.id, from, 'No pude descargar tu hoja de vida en este momento. Inténtalo nuevamente en unos minutos.');
              }
            }
          } else if (freshCandidate.currentStep === ConversationStep.DONE) {
            await reply(prisma, candidate.id, from, MENSAJE_FINAL);
          } else {
            await reply(prisma, candidate.id, from, 'Por ahora solo puedo procesar mensajes de texto para continuar con tu registro.');
          }
        } finally {
          const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id }, select: { currentStep: true } });
          debugTrace.currentStep_after = updatedCandidate?.currentStep || debugTrace.currentStep_before;
          console.log('[CV_TRACE]', JSON.stringify(debugTrace));
          await attachDebugTrace(prisma, inbound.id, debugTrace);
        }
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
