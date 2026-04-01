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
const CIERRE_NO_INTERES = 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const MENSAJE_FINAL = 'Tu información ya fue recibida correctamente. Por favor espera a que el equipo de reclutamiento se comunique contigo.';
const GUIA_CONTINUAR = 'Puedo ayudarte a continuar con la postulación. Si deseas seguir, envíame tus datos y te voy guiando.';

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
  if (!n) return false;

  const patterns = [
    'si', 'sí', 'claro', 'listo', 'ok', 'okay', 'dale', 'de una', 'hagámosle', 'vamos',
    'estoy interesado', 'estoy interesada', 'me interesa', 'quiero aplicar', 'quiero postularme',
    'quiero participar', 'deseo continuar', 'me gustaría postularme', 'quiero seguir', 'continuar'
  ];
  if (patterns.some((p) => n === p || n.includes(p))) return true;

  return /(quiero|deseo|me gustar[ií]a|vamos|listo|claro).*(aplicar|postular|continuar|seguir|participar)/i.test(n);
}

function isNegativeInterest(text) {
  const n = normalizeText(text).toLowerCase();
  return /^(no+|nop+|negativo)$|no gracias|no me interesa|no estoy interesad|no deseo|paso|ya no|prefiero no|no quiero continuar|no quiero seguir|no contin[uú]o|no continuar/i.test(n);
}

function isReopenCommand(text) {
  return normalizeText(text) === 'QUIERO CONTINUAR';
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

  const negativeExperience = /\b(no\s+tengo\s+experiencia|sin\s+experiencia)\b/i.test(remaining);
  const positiveExperience = /\b(s[ií],?\s*tengo\s+experiencia|tengo\s+experiencia|cuento\s+con\s+experiencia|experiencia\s*[:\-]?\s*s[ií])\b/i.test(remaining);
  if (negativeExperience) {
    result.experienceInfo = 'No';
  } else if (positiveExperience) {
    result.experienceInfo = 'Sí';
  }

  const expTime = remaining.match(/\b(?:tengo|llevo|cuento\s+con|experiencia\s+de)?\s*(\d+\s*(?:a[ñn]os?|mes(?:es)?|semana(?:s)?))\b/i);
  if (expTime) {
    result.experienceTime = expTime[1];
    result.experienceInfo = 'Sí';
  }

  const medicalNegative = /\b(no\s+tengo\s+ninguna\s+restricci[oó]n|no\s+tengo\s+restricciones?\s+m[ée]dicas?|no\s+presento\s+restricciones?\s+m[ée]dicas?|no\s+cuento\s+con\s+restricciones?\s+m[ée]dicas?|ninguna\s+restricci[oó]n\s+m[ée]dica|sin\s+restricciones?\s+m[ée]dicas?)\b/i.test(remaining)
    || /^(no|ninguna|ninguno)$/i.test(remaining);
  const medicalAffirmative = /\b(s[ií]\s+tengo\s+restricciones?\s+m[ée]dicas?|tengo\s+restricci[oó]n(?:\s+m[ée]dica)?|no\s+puedo\s+cargar|problema\s+de\s+columna|restricci[oó]n\s+en\s+la\s+espalda)\b/i.test(remaining);
  const medicalMatch = remaining.match(/(?:restricciones?\s+m[ée]dicas?\s*[:\-]?\s*)([^,.\n]{2,100})/i);
  if (medicalNegative) {
    result.medicalRestrictions = 'Sin restricciones médicas';
  } else if (medicalMatch) {
    const medicalValue = medicalMatch[1].trim();
    result.medicalRestrictions = /^no$/i.test(medicalValue) ? 'Sin restricciones médicas' : capitalizeWords(medicalValue);
  } else if (medicalAffirmative) {
    const snippet = remaining.match(/(tengo\s+[^,.\n]{5,80}|no\s+puedo\s+[^,.\n]{5,80}|problema\s+de\s+[^,.\n]{3,80})/i);
    result.medicalRestrictions = snippet ? capitalizeWords(snippet[1].trim()) : 'Sí, reporta restricciones médicas';
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

  const commaParts = text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (commaParts.length >= 3) {
    const tokenTypeMap = {
      cc: 'CC', cédula: 'CC', cedula: 'CC',
      ti: 'TI',
      ce: 'CE',
      pasaporte: 'Pasaporte',
      ppt: 'PPT'
    };

    for (const token of commaParts) {
      const lowered = token.toLowerCase();

      if (!result.documentType && tokenTypeMap[lowered]) {
        result.documentType = tokenTypeMap[lowered];
        continue;
      }

      if (!result.documentNumber && /^\d{6,12}$/.test(token)) {
        result.documentNumber = token;
        continue;
      }

      if (!result.age && /^\d{1,2}$/.test(token)) {
        const age = Number(token);
        if (age >= 14 && age <= 99) {
          result.age = age;
          continue;
        }
      }

      if (!result.transportMode && /\b(moto|bicicleta|bici|carro|bus)\b/i.test(token)) {
        result.transportMode = capitalizeWords(token.replace(/bici/i, 'bicicleta'));
        continue;
      }

      if (!result.medicalRestrictions && /(no\s+tengo\s+restricciones?|sin\s+restricciones?|ninguna)/i.test(token)) {
        result.medicalRestrictions = 'Sin restricciones médicas';
        continue;
      }

      if (!result.experienceInfo && /\b(no\s+tengo\s+experiencia|sin\s+experiencia)\b/i.test(token)) {
        result.experienceInfo = 'No';
        continue;
      }

      if (!result.experienceTime && (/^\d+$/.test(token) || /(\d+)\s*(a[ñn]os?|mes(?:es)?|semana(?:s)?)/i.test(token))) {
        result.experienceTime = token;
        if (!result.experienceInfo) result.experienceInfo = Number(token) > 0 ? 'Sí' : 'No';
        continue;
      }

      if (!result.neighborhood && /^[a-záéíóúñ\s]{2,40}$/i.test(token) && !/\b(no|si|sí)\b/i.test(token)) {
        result.neighborhood = capitalizeWords(token);
      }
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

function containsCandidateData(text) {
  const parsed = parseNaturalData(text);
  return Object.keys(parsed).length > 0;
}

function getNaturalDelayMs(inputText = '', outputText = '') {
  const referenceLength = Math.max(normalizeText(inputText).length, normalizeText(outputText).length, 1);
  const delayByLength = 1500 + Math.min(1000, Math.round(referenceLength * 8));
  return Math.max(1500, Math.min(2500, delayByLength));
}

function buildCapturedSummary(parsedData) {
  const labels = {
    fullName: 'nombre completo',
    documentType: 'tipo de documento',
    documentNumber: 'número de documento',
    age: 'edad',
    neighborhood: 'barrio',
    experienceInfo: 'experiencia',
    experienceTime: 'tiempo de experiencia',
    medicalRestrictions: 'restricciones médicas',
    transportMode: 'medio de transporte'
  };

  const entries = Object.entries(parsedData)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${labels[key] || key}: ${value}`);

  if (!entries.length) return '';
  return `Esto fue lo que entendí: ${entries.join(', ')}.`;
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

async function reply(prisma, candidateId, to, body, inboundText = '') {
  await sleep(getNaturalDelayMs(inboundText, body));
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
  const hasDataIntent = containsCandidateData(cleanText);

  if (candidate.status === CandidateStatus.NO_INTERESADO && isReopenCommand(cleanText)) {
    const missing = getMissingFields(candidate);
    if (missing.length === 0) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { status: CandidateStatus.REGISTRADO, currentStep: ConversationStep.DONE }
      });
      await reply(prisma, candidate.id, from, MENSAJE_FINAL);
      return;
    }

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { status: CandidateStatus.NUEVO, currentStep: ConversationStep.COLLECTING_DATA }
    });
    await reply(prisma, candidate.id, from, `Perfecto, reactivamos tu postulación. Conservé tus datos y solo faltan: ${missing.join(', ')}.`);
    return;
  }

  if (isNegativeInterest(cleanText) && candidate.status !== CandidateStatus.RECHAZADO) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { status: CandidateStatus.NO_INTERESADO, currentStep: ConversationStep.DONE }
    });
    await reply(prisma, candidate.id, from, CIERRE_NO_INTERES);
    return;
  }

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
    if (isAffirmativeInterest(cleanText) || hasDataIntent) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      if (hasDataIntent) {
        const parsedData = parseNaturalData(cleanText);
        if (shouldRejectByRequirements(cleanText, parsedData)) {
          await rejectCandidate(prisma, candidate.id, from);
          return;
        }

        await prisma.candidate.update({ where: { id: candidate.id }, data: { ...parsedData, currentStep: ConversationStep.COLLECTING_DATA } });
        const updated = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        const missing = getMissingFields(updated);
        if (missing.length === 0) {
          await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
          await reply(prisma, candidate.id, from, MENSAJE_FINAL);
        } else {
          const summary = buildCapturedSummary(parsedData);
          await reply(prisma, candidate.id, from, `${summary} Para continuar solo me falta: ${missing.join(', ')}`);
        }
        return;
      }
      await reply(prisma, candidate.id, from, SOLICITAR_DATOS);
      return;
    }

    const parsedData = parseNaturalData(cleanText);
    if (shouldRejectByRequirements(cleanText, parsedData)) {
      await rejectCandidate(prisma, candidate.id, from);
      return;
    }

    if (Object.keys(parsedData).length >= 1) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { ...parsedData, currentStep: ConversationStep.COLLECTING_DATA } });
      const updated = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      const missing = getMissingFields(updated);
      if (missing.length === 0) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
        await reply(prisma, candidate.id, from, MENSAJE_FINAL);
      } else {
        const summary = buildCapturedSummary(parsedData);
        await reply(prisma, candidate.id, from, `${summary} Para continuar solo me falta: ${missing.join(', ')}`);
      }
      return;
    }

    await reply(prisma, candidate.id, from, GUIA_CONTINUAR);
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

    const summary = buildCapturedSummary(parsedData);
    const response = summary
      ? `${summary} Para continuar solo me falta: ${missing.join(', ')}`
      : `Gracias. Para continuar solo me falta: ${missing.join(', ')}`;
    await reply(prisma, candidate.id, from, response);
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
