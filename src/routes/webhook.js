import express from 'express';
import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from '../services/whatsapp.js';

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
const CIERRE_NO_INTERES = 'Gracias por tu tiempo. Si en otro momento deseas participar en una vacante, puedes escribirnos de nuevo. Te deseamos un excelente día.';
const MENSAJE_FINAL = 'Tu información ya fue recibida correctamente. Por favor espera a que el equipo de reclutamiento se comunique contigo.';

function normalizeText(text = '') {
  return text.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFAQ(text) {
  const n = normalizeText(text).toLowerCase();
  return /(cu[aá]ndo\s+(empiezan|me llaman|inicia|arranca|se comunican)|para\s+cu[aá]ndo)/i.test(n);
}

function isAffirmativeInterest(text) {
  const n = normalizeText(text).toLowerCase();
  const patterns = [
    'si', 'sí', 'claro', 'listo', 'ok', 'okay', 'me interesa', 'quiero aplicar',
    'quiero postularme', 'quiero participar', 'de una', 'hagámosle', 'vamos'
  ];
  return patterns.some((p) => n === p || n.includes(p));
}

function isNegativeInterest(text) {
  const n = normalizeText(text).toLowerCase();
  return /(no gracias|no me interesa|no estoy interesad|no deseo|paso|ya no|no\b)/i.test(n);
}

function shouldRejectByRequirements(text, parsed = {}) {
  const n = normalizeText(text).toLowerCase();
  if (parsed.age && (parsed.age < 18 || parsed.age > 50)) return true;
  if (/no\s+tengo\s+documento\s+vigente|documento\s+vencido|sin\s+documento\s+vigente/.test(n)) return true;
  if (/(soy\s+extranjero|soy\s+venezolan|extranjera?)/.test(n) && /(no\s+tengo\s+ppt|sin\s+ppt|ppt\s+vencido)/.test(n)) return true;
  return false;
}

function capitalizeWords(str) {
  return str.toLowerCase().replace(/(^|\s)(\S)/g, (_m, space, char) => space + char.toUpperCase());
}

function parseNaturalData(text) {
  const result = {};
  let remaining = text;

  const docRegex = /\b(c\.?\s*c\.?|c[ée]dula|t\.?\s*i\.?|tarjeta\s+de\s+identidad|c\.?\s*e\.?|c[ée]dula\s+de\s+extranjer[íi]a|pasaporte|ppt)\s*(?:es|:|\-|#|\.|\s)\s*(\d{6,12})\b/i;
  const docMatch = remaining.match(docRegex);
  if (docMatch) {
    const tipoRaw = docMatch[1].toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
    const tipoMap = {
      cc: 'CC', cedula: 'CC', cédula: 'CC',
      ti: 'TI', tarjetadeidentidad: 'TI',
      ce: 'CE', ceduladeextranjería: 'CE', ceduladeextranjeria: 'CE',
      pasaporte: 'Pasaporte', ppt: 'PPT'
    };
    result.documentType = tipoMap[tipoRaw] || tipoRaw.toUpperCase();
    result.documentNumber = docMatch[2];
    remaining = remaining.replace(docMatch[0], ' ');
  }

  if (!result.documentNumber) {
    const docNum = remaining.match(/(?:^|\s)(\d{7,12})(?:\s|$)/);
    if (docNum) {
      result.documentNumber = docNum[1];
      remaining = remaining.replace(docNum[1], ' ');
    }
  }

  const ageMatch = remaining.match(/\b(?:edad\s*[:\-]?\s*|tengo\s+)?(\d{1,2})\s*(?:a[ñn]os?)?\b/i);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age >= 14 && age <= 99) {
      result.age = age;
      remaining = remaining.replace(ageMatch[0], ' ');
    }
  }

  const barrioMatch = remaining.match(/\b(?:barrio|zona|sector|localidad|vereda)\s*[:\-]?\s*([^,.\n]{2,60})/i);
  if (barrioMatch) {
    result.neighborhood = capitalizeWords(barrioMatch[1].trim());
    remaining = remaining.replace(barrioMatch[0], ' ');
  }

  const expInfo = remaining.match(/(?:experiencia\s*(?:en\s+el\s+cargo)?\s*[:\-]?\s*)(sí|si|no|tengo|no\s+tengo|cuento\s+con|sin\s+experiencia)/i);
  if (expInfo) {
    const raw = expInfo[1].toLowerCase();
    result.experienceInfo = /no|sin/.test(raw) ? 'No' : 'Sí';
  } else if (/\b(s[ií],?\s*tengo\s+experiencia|tengo\s+experiencia|sin\s+experiencia|no\s+tengo\s+experiencia)\b/i.test(remaining)) {
    result.experienceInfo = /no|sin/i.test(remaining) ? 'No' : 'Sí';
  }

  const expTime = remaining.match(/(\d+\s*(?:a[ñn]os?|mes(?:es)?|semana(?:s)?))/i);
  if (expTime && /experiencia|cargo|trabaj/i.test(remaining)) {
    result.experienceTime = expTime[1];
  }

  const medicalMatch = remaining.match(/(?:restricciones?\s+m[ée]dicas?\s*[:\-]?\s*)([^,.\n]{2,100})/i);
  if (medicalMatch) {
    result.medicalRestrictions = capitalizeWords(medicalMatch[1].trim());
  } else if (/\b(no\s+tengo\s+restricciones?|ninguna)\b/i.test(remaining)) {
    result.medicalRestrictions = 'Ninguna';
  }

  const transportMatch = remaining.match(/\b(moto|bicicleta|bici|carro|bus|ninguno|ninguna)\b/i);
  if (transportMatch) {
    result.transportMode = capitalizeWords(transportMatch[1].replace('bici', 'bicicleta'));
  }

  const namePref = text.match(/(?:me\s+llamo|soy|mi\s+nombre\s+es|nombre\s*[:\-]?)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ ]{4,60})/i);
  if (namePref) {
    result.fullName = capitalizeWords(namePref[1].trim());
  } else {
    const first = text.split(/[\n,]/)[0]?.trim() || '';
    if (/^[A-ZÁÉÍÓÚÑa-záéíóúñ]+(\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){1,4}$/.test(first)) {
      result.fullName = capitalizeWords(first);
    }
  }

  return result;
}

function getMissingFields(candidate) {
  const missing = [];
  if (!candidate.fullName) missing.push('nombre completo');
  if (!candidate.documentType) missing.push('tipo de documento');
  if (!candidate.documentNumber) missing.push('número de documento');
  if (!candidate.age) missing.push('edad');
  if (!candidate.neighborhood) missing.push('barrio');
  if (!candidate.experienceInfo) missing.push('experiencia en el cargo');
  if (!candidate.experienceTime) missing.push('tiempo de experiencia');
  if (!candidate.medicalRestrictions) missing.push('restricciones médicas');
  if (!candidate.transportMode) missing.push('medio de transporte');
  return missing;
}

async function saveInboundMessage(prisma, candidateId, message, body, type) {
  try {
    await prisma.message.create({
      data: {
        candidateId,
        waMessageId: message.id,
        direction: MessageDirection.INBOUND,
        messageType: type,
        body,
        rawPayload: message
      }
    });
    return true;
  } catch (error) {
    if (String(error?.message || '').includes('Unique constraint')) return false;
    throw error;
  }
}

async function saveOutboundMessage(prisma, candidateId, body) {
  await prisma.message.create({
    data: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload: { body }
    }
  });
}

async function reply(prisma, candidateId, to, body) {
  await sleep(900);
  await sendTextMessage(to, body);
  await saveOutboundMessage(prisma, candidateId, body);
}

async function rejectCandidate(prisma, candidateId, from) {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: { status: CandidateStatus.RECHAZADO, currentStep: ConversationStep.DONE }
  });
  await reply(prisma, candidateId, from, DESCARTE_MSG);
}

async function processText(prisma, candidate, from, text) {
  const cleanText = normalizeText(text);

  if (isFAQ(cleanText)) {
    await reply(prisma, candidate.id, from, FAQ_RESPONSE);
    return;
  }

  if (candidate.status === CandidateStatus.RECHAZADO) {
    await reply(prisma, candidate.id, from, DESCARTE_MSG);
    return;
  }

  if (candidate.currentStep === ConversationStep.MENU) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
    await reply(prisma, candidate.id, from, SALUDO_INICIAL);
    return;
  }

  if (candidate.currentStep === ConversationStep.DONE) {
    await reply(prisma, candidate.id, from, MENSAJE_FINAL);
    return;
  }

  if (candidate.currentStep === ConversationStep.GREETING_SENT) {
    if (isNegativeInterest(cleanText)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE } });
      await reply(prisma, candidate.id, from, CIERRE_NO_INTERES);
      return;
    }

    if (isAffirmativeInterest(cleanText)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      await reply(prisma, candidate.id, from, SOLICITAR_DATOS);
      return;
    }

    const parsedData = parseNaturalData(cleanText);
    if (shouldRejectByRequirements(cleanText, parsedData)) {
      await rejectCandidate(prisma, candidate.id, from);
      return;
    }

    if (Object.keys(parsedData).length >= 2) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { ...parsedData, currentStep: ConversationStep.COLLECTING_DATA } });
      const updated = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      const missing = getMissingFields(updated);
      if (missing.length === 0) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
        await reply(prisma, candidate.id, from, MENSAJE_FINAL);
      } else {
        await reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`);
      }
      return;
    }

    await reply(prisma, candidate.id, from, 'Si deseas continuar con la postulación, respóndeme con un “sí” y te pido los datos. Si prefieres, también puedes escribirme tu duda sobre fechas del proceso.');
    return;
  }

  if (candidate.currentStep === ConversationStep.COLLECTING_DATA) {
    const parsedData = parseNaturalData(cleanText);
    if (shouldRejectByRequirements(cleanText, parsedData)) {
      await rejectCandidate(prisma, candidate.id, from);
      return;
    }

    const updatedData = {};
    const fillableFields = ['fullName', 'documentType', 'documentNumber', 'age', 'neighborhood', 'experienceInfo', 'experienceTime', 'medicalRestrictions', 'transportMode'];
    for (const field of fillableFields) {
      if (parsedData[field] && !candidate[field]) updatedData[field] = parsedData[field];
    }

    if (Object.keys(updatedData).length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: updatedData });
    }

    const updated = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const missing = getMissingFields(updated);

    if (missing.length === 0) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO }
      });
      await reply(prisma, candidate.id, from, MENSAJE_FINAL);
      return;
    }

    await reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`);
    return;
  }
}

export function webhookRouter(prisma) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
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
          const wasNew = await saveInboundMessage(prisma, candidate.id, message, body, MessageType.TEXT);
          if (!wasNew) continue;

          const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          await processText(prisma, freshCandidate, from, body);
          continue;
        }

        const wasNew = await saveInboundMessage(prisma, candidate.id, message, message.document?.filename || '', MessageType.UNKNOWN);
        if (!wasNew) continue;

        const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        if (freshCandidate.currentStep === ConversationStep.DONE) {
          await reply(prisma, candidate.id, from, MENSAJE_FINAL);
        } else {
          await reply(prisma, candidate.id, from, 'Por ahora solo puedo procesar mensajes de texto para continuar con tu registro.');
        }
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
