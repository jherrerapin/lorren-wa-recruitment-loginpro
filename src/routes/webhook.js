// Importa Express para crear el enrutador del webhook.
import express from 'express';

// Importa enums generados por Prisma para mantener consistencia tipada con la base de datos.
import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';

// Importa utilidades para extraer mensajes del payload y responder por WhatsApp.
import { extractMessages, sendTextMessage } from '../services/whatsapp.js';

// Importa utilidades para descargar medios adjuntos desde WhatsApp.
import { fetchMediaMetadata, downloadMedia } from '../services/media.js';

// ─────────────────────────────────────────────────────────
// Información de la vacante (fuente única de verdad para FAQ y saludo)
// ─────────────────────────────────────────────────────────

const INFO_VACANTE = {
  cargo: 'Auxiliar de Cargue y Descargue',
  genero: 'personal masculino',
  ciudad: 'Ibagué',
  sector: 'Sector Aeropuerto',
  horario: 'Turnos rotativos de lunes a domingo, con un día compensatorio. Se requiere disponibilidad para turnos rotativos.',
  salario: 'Salario Mínimo Mensual Legal Vigente (SMMLV) con prestaciones de ley.',
  fechasPago: 'Pago quincenal.',
  contrato: 'Contrato por obra labor directamente con la empresa.',
  transporte: 'Debe contar con medio de transporte propio: moto o bicicleta.',
  requisitos: 'Tener entre 18 y 50 años. Contar con documento de identidad vigente. Si es extranjero, debe tener PPT (Permiso por Protección Temporal) vigente. Contar con medio de transporte propio (moto o bicicleta).'
};

// Texto formateado de la vacante para compartir en el saludo.
const INFO_TEXT = `*Vacante: ${INFO_VACANTE.cargo} (${INFO_VACANTE.genero})*

Estamos en búsqueda de Auxiliares de Cargue y Descargue para trabajar en ${INFO_VACANTE.ciudad}. El lugar de trabajo es en el ${INFO_VACANTE.sector}.

*Características del Puesto:*
- Turnos rotativos de lunes a domingo, con un día compensatorio. Se requiere disponibilidad para turnos rotativos.
- Pago quincenal.
- Salario: SMMLV.
- Contrato por obra labor directamente con la empresa.
- Prestaciones de ley.
- Requisitos: Tener entre 18 y 50 años. Contar con documento de identidad vigente. Si es extranjero, debe tener PPT vigente. Contar con medio de transporte propio (moto o bicicleta).`;

// ─────────────────────────────────────────────────────────
// Mensajes del bot
// ─────────────────────────────────────────────────────────

const SALUDO_INICIAL = `Hola, buen día. Gracias por escribirnos. Somos el equipo de selección de LoginPro.

Te comparto la información de la vacante disponible:

${INFO_TEXT}

¿Te interesa postularte o tienes alguna pregunta sobre la vacante?`;

const SOLICITAR_DATOS = `¡Perfecto! Para registrarte necesito los siguientes datos:

- Nombre completo
- Tipo y número de documento (ej: CC 1234567890)
- Edad
- Ciudad
- Barrio o zona donde vives

Puedes enviarlos como prefieras, en un solo mensaje o por partes.`;

const MENSAJE_PREGUNTAR_CV = `Ahora necesito que me envíes tu hoja de vida en formato PDF o Word por este chat.`;

const MENSAJE_CV_RECIBIDO = `¡Perfecto! Tu hoja de vida ha sido recibida correctamente.`;

const MENSAJE_YA_REGISTRADO = `Ya te encuentras registrado/a en nuestro sistema. Recuerda que la entrevista se realizará el *8 de abril*. Está atento/a al llamado con el lugar y hora exacta. ¡Éxitos!`;

// ─────────────────────────────────────────────────────────
// Detección de intención del candidato
// ─────────────────────────────────────────────────────────

// Normaliza texto entrante.
function normalizeText(text = '') {
  return text.trim();
}

// Evalúa si el candidato expresó interés positivo.
function isAffirmativeInterest(text) {
  const n = normalizeText(text).toLowerCase();
  const patterns = [
    'si', 'sí', 'claro', 'dale', 'listo', 'va', 'ok', 'okay',
    'estoy interesado', 'me interesa', 'quiero aplicar', 'quiero postularme',
    'cómo aplico', 'como aplico', 'cómo me inscribo', 'como me inscribo',
    'quiero inscribirme', 'me gustaría aplicar', 'me gustaria aplicar',
    'quiero participar', 'por supuesto', 'claro que sí', 'claro que si',
    'cómo hago', 'como hago', 'dónde me inscribo', 'donde me inscribo'
  ];
  return patterns.some((p) => n === p || n.includes(p));
}

// Evalúa si la respuesta indica que no desea continuar.
function isNegativeInterest(text) {
  const n = normalizeText(text).toLowerCase();
  const patterns = ['no gracias', 'no me interesa', 'no estoy interesado', 'no, gracias', 'negativo'];
  return patterns.some((p) => n === p || n.includes(p));
}

// ─────────────────────────────────────────────────────────
// FAQ — Detección y respuesta de preguntas frecuentes
// ─────────────────────────────────────────────────────────

// Detecta si el mensaje es una pregunta frecuente sobre la vacante y devuelve la respuesta.
// Retorna null si no es una FAQ.
function detectFAQ(text) {
  const n = normalizeText(text).toLowerCase();

  // Horarios
  if (/horario|hora|jornada|turno|qu[ée] hora/.test(n)) {
    return `${INFO_VACANTE.horario}\n\n¿Te gustaría postularte?`;
  }

  // Salario
  if (/salario|sueldo|pag[ao]|cu[áa]nto (pagan|gana|es el sueldo)|remuneraci[óo]n|plata/.test(n)) {
    return `${INFO_VACANTE.salario} ${INFO_VACANTE.fechasPago}\n\n¿Te gustaría postularte?`;
  }

  // Fechas de pago
  if (/fecha.*(pago|pagan)|cu[áa]ndo pagan|d[íi]a.*(pago|pagan)/.test(n)) {
    return `${INFO_VACANTE.fechasPago}\n\n¿Te gustaría postularte?`;
  }

  // Ubicación
  if (/ubicaci[óo]n|d[óo]nde (es|queda|est[áa])|direcci[óo]n|lugar|sector|sitio/.test(n)) {
    return `El lugar de trabajo es en ${INFO_VACANTE.ciudad}, ${INFO_VACANTE.sector}.\n\n¿Te gustaría postularte?`;
  }

  // Contrato
  if (/contrato|tipo de contrato|vinculaci[óo]n|qu[ée] tipo/.test(n)) {
    return `${INFO_VACANTE.contrato} Incluye todas las prestaciones de ley.\n\n¿Te gustaría postularte?`;
  }

  // Requisitos
  if (/requisito|qu[ée] (necesito|piden|se necesita)|condici[óo]n/.test(n)) {
    return `${INFO_VACANTE.requisitos}\n\n¿Te gustaría postularte?`;
  }

  // Transporte
  if (/transporte|moto|bicicleta|bici|c[óo]mo llego/.test(n)) {
    return `${INFO_VACANTE.transporte}\n\n¿Te gustaría postularte?`;
  }

  // Extranjeros / PPT
  if (/soy\s+(venezolan[oa]|extranjero|extranjera)|necesito\s+papeles|documentos?\s+(si|s[ií])\s+soy\s+extranjero|ppt|permiso\s+(por|de)\s+protecci[óo]n\s+temporal/.test(n)) {
    return 'Sí, puedes aplicar. Si eres extranjero, necesitas tener el PPT (Permiso por Protección Temporal) vigente. ¿Te gustaría postularte?';
  }

  // Cómo aplico (se trata como interés afirmativo en el step GREETING_SENT)
  if (/c[óo]mo (aplico|me inscribo|hago|postulo)|d[óo]nde me inscribo|quiero aplicar/.test(n)) {
    return null; // Se manejará como interés afirmativo
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// Parseo inteligente de datos del candidato desde texto libre
// ─────────────────────────────────────────────────────────

// Lista de ciudades colombianas conocidas para detección.
const CIUDADES_COLOMBIANAS = [
  'ibagué', 'ibague', 'bogotá', 'bogota', 'medellín', 'medellin',
  'cali', 'barranquilla', 'cartagena', 'bucaramanga', 'pereira',
  'manizales', 'cúcuta', 'cucuta', 'villavicencio', 'pasto',
  'santa marta', 'montería', 'monteria', 'neiva', 'armenia',
  'popayán', 'popayan', 'sincelejo', 'valledupar', 'tunja',
  'florencia', 'quibdó', 'quibdo', 'riohacha', 'yopal',
  'sogamoso', 'duitama', 'girardot', 'espinal', 'melgar',
  'honda', 'líbano', 'libano', 'chaparral', 'guamo',
  'soacha', 'fusagasugá', 'fusagasuga', 'zipaquirá', 'zipaquira',
  'chía', 'chia', 'cajicá', 'cajica', 'facatativá', 'facatativa',
  'mosquera', 'funza', 'madrid', 'tocancipá', 'tocancipa'
];

// Extrae datos del candidato de texto libre usando heurísticas.
// Retorna un objeto con los campos encontrados (solo los detectados).
function parseNaturalData(text) {
  const result = {};
  let remaining = text;

  // 1. Detectar tipo y número de documento
  // Patrones: "CC 1234567890", "cédula 1234567890", "mi cedula es 1234567890", "TI 1234567890"
  const docRegex = /\b(c\.?\s*c\.?|c[ée]dula|t\.?\s*i\.?|tarjeta\s+de\s+identidad|c\.?\s*e\.?|c[ée]dula\s+de\s+extranjer[íi]a|pasaporte|ppt|permiso\s+(?:por|de)\s+protecci[óo]n\s+temporal)\s*(?:es|:|\-|#|\.|\s)\s*(\d{6,12})\b/i;
  const docMatch = remaining.match(docRegex);
  if (docMatch) {
    const tipoRaw = docMatch[1].toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
    const numero = docMatch[2];

    // Mapear tipo de documento a abreviatura estándar
    const tipoMap = {
      'cc': 'CC', 'cedula': 'CC', 'cédula': 'CC',
      'ti': 'TI', 'tarjetadeidentidad': 'TI',
      'ce': 'CE', 'ceduladeextranjería': 'CE', 'ceduladeextranjeria': 'CE',
      'pasaporte': 'Pasaporte',
      'ppt': 'PPT', 'permisoporproteccióntemporal': 'PPT', 'permisoporprotecciontemporal': 'PPT',
      'permisodeproteccióntemporal': 'PPT', 'permisodeprotecciontemporal': 'PPT'
    };
    result.documentType = tipoMap[tipoRaw] || tipoRaw.toUpperCase();
    result.documentNumber = numero;

    // Remover del texto restante para no confundir con otros campos
    remaining = remaining.replace(docMatch[0], ' ');
  }

  // Si no se encontró con prefijo, buscar un número largo que pueda ser documento (7-12 dígitos).
  // No debe confundirse con la edad (1-2 dígitos).
  if (!result.documentNumber) {
    const soloNumero = remaining.match(/(?:^|\s)(\d{7,12})(?:\s|$)/m);
    if (soloNumero) {
      result.documentNumber = soloNumero[1];
      remaining = remaining.replace(soloNumero[1], ' ');
    }
  }

  // 2. Detectar edad
  // Patrones: "25 años", "tengo 25", "edad 25", "25 años de edad"
  const edadRegex = /\b(?:tengo\s+)?(\d{1,2})\s*(?:años?|a[ñn]os?)(?:\s+de\s+edad)?\b/i;
  const edadMatch = remaining.match(edadRegex);
  if (edadMatch) {
    const edad = parseInt(edadMatch[1], 10);
    if (edad >= 18 && edad <= 50) {
      result.age = edad;
      remaining = remaining.replace(edadMatch[0], ' ');
    } else if (edad > 50) {
      result.ageRejected = true;
    }
  }

  // Si no se encontró con "años", buscar "edad: 25" o "edad 25"
  if (!result.age && !result.ageRejected) {
    const edadAlt = remaining.match(/\bedad\s*[:\-]?\s*(\d{1,2})\b/i);
    if (edadAlt) {
      const edad = parseInt(edadAlt[1], 10);
      if (edad >= 18 && edad <= 50) {
        result.age = edad;
        remaining = remaining.replace(edadAlt[0], ' ');
      } else if (edad > 50) {
        result.ageRejected = true;
      }
    }
  }

  // 3. Detectar barrio/zona (antes de ciudad para no confundir)
  // Patrones: "barrio centro", "zona industrial", "sector el salado", "localidad kennedy"
  const barrioRegex = /\b(?:barrio|zona|localidad|sector|vereda)\s*[:\-]?\s*(.+?)(?:\s*[,.\n]|$)/i;
  const barrioMatch = remaining.match(barrioRegex);
  if (barrioMatch) {
    result.zone = barrioMatch[1].trim();
    remaining = remaining.replace(barrioMatch[0], ' ');
  }

  // 4. Detectar ciudad
  const normalizedRemaining = remaining.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  for (const ciudad of CIUDADES_COLOMBIANAS) {
    const ciudadNorm = ciudad.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalizedRemaining.includes(ciudadNorm)) {
      // Capitalizar la primera letra de cada palabra
      result.city = ciudad.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      // Correcciones de tildes para ciudades principales
      const correcciones = {
        'Ibague': 'Ibagué', 'Bogota': 'Bogotá', 'Medellin': 'Medellín',
        'Cucuta': 'Cúcuta', 'Monteria': 'Montería', 'Popayan': 'Popayán',
        'Quibdo': 'Quibdó', 'Libano': 'Líbano', 'Fusagasuga': 'Fusagasugá',
        'Zipaquira': 'Zipaquirá', 'Chia': 'Chía', 'Cajica': 'Cajicá',
        'Facatativa': 'Facatativá', 'Tocancipa': 'Tocancipá'
      };
      result.city = correcciones[result.city] || result.city;
      break;
    }
  }

  // Si hay un guión o "de" después de ciudad, puede ser el barrio
  if (result.city && !result.zone) {
    const cityIdx = remaining.toLowerCase().indexOf(result.city.toLowerCase());
    if (cityIdx !== -1) {
      const afterCity = remaining.substring(cityIdx + result.city.length);
      const barrioDespues = afterCity.match(/^\s*[-–,]\s*(.+?)(?:\s*[,.\n]|$)/);
      if (barrioDespues) {
        result.zone = barrioDespues[1].trim();
      }
    }
  }

  // 5. Detectar nombre completo
  // El nombre es generalmente lo que queda al inicio del texto, antes de datos numéricos.
  // Patrones: "me llamo Juan Pérez", "soy Juan Pérez", "mi nombre es Juan Pérez", "nombre: Juan Pérez"
  const nombrePrefijo = remaining.match(/(?:me\s+llamo|soy|mi\s+nombre\s+es|nombre\s*[:\-]?)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ ]{2,49})/i);
  if (nombrePrefijo) {
    let nombre = nombrePrefijo[1].trim();
    // Limpiar si el nombre incluye conectores, ciudades o datos que no son parte del nombre
    nombre = nombre.replace(/\s*(tengo|cedula|cédula|c\.?c\.?|de\s+\d|vivo|\d+\s*años?|ibagu[ée]|bogot[áa]|medell[íi]n|cali|barranquilla).*$/i, '').trim();
    if (nombre.length >= 3 && nombre.split(/\s+/).length >= 2) {
      result.fullName = capitalizeWords(nombre);
    }
  }

  // Si no hay prefijo, intentar tomar la primera línea o segmento que parezca nombre
  if (!result.fullName) {
    // Tomar la primera línea del texto original para buscar nombre
    const firstLine = text.split(/[\n,]/)[0].trim();
    // Construir regex de ciudades para limpiar del candidato a nombre
    const ciudadesPattern = CIUDADES_COLOMBIANAS.join('|');
    const ciudadesRegex = new RegExp(`\\b(${ciudadesPattern})\\b`, 'gi');
    // Limpiar de números, palabras clave, conectores y ciudades
    const cleanedForName = firstLine
      .replace(/\d+/g, '')
      .replace(/\b(tengo|años?|cedula|cédula|c\.?c\.?|t\.?i\.?|c\.?e\.?|vivo|en|el|la|los|las|del|de|barrio|zona|sector|localidad|edad|soy|me\s+llamo|mi\s+nombre\s+es)\b/gi, '')
      .replace(ciudadesRegex, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Validar que parece un nombre (al menos dos palabras, solo letras)
    if (/^[A-ZÁÉÍÓÚÑa-záéíóúñ]+(\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){1,5}$/.test(cleanedForName) && cleanedForName.length >= 5) {
      result.fullName = capitalizeWords(cleanedForName);
    }
  }

  return result;
}

// Capitaliza la primera letra de cada palabra (soporta tildes).
function capitalizeWords(str) {
  return str.toLowerCase().replace(/(^|\s)(\S)/g, (_m, space, char) => space + char.toUpperCase());
}

// Determina qué campos faltan de los datos requeridos.
function getMissingFields(candidate) {
  const missing = [];
  if (!candidate.fullName) missing.push('nombre completo');
  if (!candidate.documentNumber) missing.push('tipo y número de documento');
  if (!candidate.age) missing.push('edad');
  if (!candidate.city) missing.push('ciudad');
  if (!candidate.zone) missing.push('barrio o zona');
  return missing;
}

// Genera un mensaje amigable pidiendo solo los datos faltantes.
function buildMissingFieldsMessage(candidate, missing) {
  const nombre = candidate.fullName ? candidate.fullName.split(' ')[0] : '';
  const prefix = nombre ? `Gracias ${nombre}, ya casi terminamos. ` : '';

  if (missing.length === 1) {
    return `${prefix}Solo me falta tu ${missing[0]}.`;
  }

  const last = missing.pop();
  return `${prefix}Me faltan: ${missing.join(', ')} y ${last}.`;
}

// Genera un mensaje de confirmación con los datos del candidato.
function buildConfirmationMessage(candidate) {
  const lines = [
    `Estos son tus datos:`,
    ``,
    `*Nombre:* ${candidate.fullName}`,
    `*Documento:* ${candidate.documentType || 'CC'} ${candidate.documentNumber}`,
    `*Edad:* ${candidate.age} años`,
    `*Ciudad:* ${candidate.city}`,
    `*Barrio/Zona:* ${candidate.zone}`,
    ``,
    `¿Los datos son correctos? Responde *sí* para confirmar o *no* para corregirlos.`
  ];
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────
// Persistencia de mensajes (sin cambios funcionales)
// ─────────────────────────────────────────────────────────

// Guarda un mensaje entrante y controla duplicados por identificador de WhatsApp.
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
    if (String(error?.message || '').includes('Unique constraint')) {
      return false;
    }
    throw error;
  }
}

// Guarda un mensaje saliente del bot.
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

// Envía una respuesta por WhatsApp y luego la persiste en la base de datos.
async function reply(prisma, candidateId, to, body) {
  await sendTextMessage(to, body);
  await saveOutboundMessage(prisma, candidateId, body);
}

// ─────────────────────────────────────────────────────────
// Procesamiento del flujo conversacional
// ─────────────────────────────────────────────────────────

// Procesa un mensaje de texto según el paso actual del candidato.
async function processText(prisma, candidate, from, text) {
  const cleanText = normalizeText(text);

  // ── MENU: Primer contacto — enviar saludo con info de vacante ──
  if (candidate.currentStep === ConversationStep.MENU) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentStep: ConversationStep.GREETING_SENT }
    });
    await reply(prisma, candidate.id, from, SALUDO_INICIAL);
    return;
  }

  // ── ASK_CV: Esperando hoja de vida (obligatoria) ──
  if (candidate.currentStep === ConversationStep.ASK_CV) {
    const n = cleanText.toLowerCase();
    // Si dice que no tiene CV, informar que queda pendiente (NO avanza)
    if (/no tengo|no la tengo|no cuento|después|despues|luego|ahora no|no puedo/i.test(n)) {
      await reply(
        prisma, candidate.id, from,
        'Para completar tu registro necesitamos tu hoja de vida. Si no la tienes en este momento, puedes enviarla cuando la tengas. Estaremos atentos.'
      );
      return;
    }
    // Cualquier otro texto — recordar que necesita enviar el documento
    await reply(
      prisma, candidate.id, from,
      'Necesito tu hoja de vida en formato PDF o Word. Por favor envíala como archivo adjunto en este chat.'
    );
    return;
  }

  // ── DONE: Candidato ya registrado ──
  if (candidate.currentStep === ConversationStep.DONE) {
    await reply(prisma, candidate.id, from, MENSAJE_YA_REGISTRADO);
    return;
  }

  // ── GREETING_SENT: Esperando respuesta de interés o FAQ ──
  if (candidate.currentStep === ConversationStep.GREETING_SENT) {
    // Primero verificar si es una FAQ
    const faqResponse = detectFAQ(cleanText);
    if (faqResponse) {
      await reply(prisma, candidate.id, from, faqResponse);
      return;
    }

    // Si confirma interés, pasar a captura de datos
    if (isAffirmativeInterest(cleanText)) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { currentStep: ConversationStep.COLLECTING_DATA }
      });
      await reply(prisma, candidate.id, from, SOLICITAR_DATOS);
      return;
    }

    // Si responde negativamente
    if (isNegativeInterest(cleanText)) {
      await reply(
        prisma, candidate.id, from,
        'Entendido, no hay problema. Si más adelante te interesa, aquí estaremos para ayudarte. ¡Que tengas buen día!'
      );
      return;
    }

    // Intentar detectar si el mensaje contiene datos (el candidato puede enviar datos directamente)
    const parsedData = parseNaturalData(cleanText);

    // Validar edad: si el candidato tiene 50+ años, rechazar amablemente
    if (parsedData.ageRejected) {
      await reply(
        prisma, candidate.id, from,
        'Lamentablemente la vacante es para personas entre 18 y 50 años. Gracias por tu interés.'
      );
      return;
    }

    const fieldsFound = Object.keys(parsedData).filter(k => k !== 'ageRejected').length;
    if (fieldsFound >= 2) {
      // El candidato ya está enviando datos — mover a COLLECTING_DATA y procesarlos
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          ...parsedData,
          currentStep: ConversationStep.COLLECTING_DATA
        }
      });

      const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      const missing = getMissingFields(updatedCandidate);

      if (missing.length === 0) {
        // Tiene todos los datos, pasar a confirmación
        await prisma.candidate.update({
          where: { id: candidate.id },
          data: { currentStep: ConversationStep.CONFIRMING_DATA }
        });
        await reply(prisma, candidate.id, from, buildConfirmationMessage(updatedCandidate));
      } else {
        await reply(prisma, candidate.id, from, buildMissingFieldsMessage(updatedCandidate, missing));
      }
      return;
    }

    // Si no es FAQ, ni interés, ni datos — pedir clarificación
    await reply(
      prisma, candidate.id, from,
      '¿Te gustaría postularte a la vacante? Si tienes alguna pregunta sobre el puesto, con gusto te la resuelvo.'
    );
    return;
  }

  // ── COLLECTING_DATA: Capturando datos del candidato de forma natural ──
  if (candidate.currentStep === ConversationStep.COLLECTING_DATA) {
    // Parsear datos del mensaje
    const parsedData = parseNaturalData(cleanText);

    // Validar edad: si el candidato tiene 50+ años, rechazar amablemente
    if (parsedData.ageRejected) {
      await reply(
        prisma, candidate.id, from,
        'Lamentablemente la vacante es para personas entre 18 y 50 años. Gracias por tu interés.'
      );
      return;
    }

    // Solo actualizar los campos que se detectaron y que aún faltan
    const updateData = {};
    if (parsedData.fullName && !candidate.fullName) updateData.fullName = parsedData.fullName;
    if (parsedData.documentType && !candidate.documentType) updateData.documentType = parsedData.documentType;
    if (parsedData.documentNumber && !candidate.documentNumber) updateData.documentNumber = parsedData.documentNumber;
    if (parsedData.age && !candidate.age) updateData.age = parsedData.age;
    if (parsedData.city && !candidate.city) updateData.city = parsedData.city;
    if (parsedData.zone && !candidate.zone) updateData.zone = parsedData.zone;

    // Si no se detectó ningún dato nuevo y hay exactamente un campo faltante,
    // intentar asignar el texto completo a ese campo.
    const currentMissing = getMissingFields(candidate);
    if (Object.keys(updateData).length === 0 && currentMissing.length === 1) {
      const field = currentMissing[0];
      if (field === 'nombre completo') updateData.fullName = capitalizeWords(cleanText);
      else if (field === 'tipo y número de documento') updateData.documentNumber = cleanText;
      else if (field === 'edad') {
        const num = parseInt(cleanText, 10);
        if (num > 50) {
          await reply(
            prisma, candidate.id, from,
            'Lamentablemente la vacante es para personas entre 18 y 50 años. Gracias por tu interés.'
          );
          return;
        }
        if (num >= 18 && num <= 50) updateData.age = num;
      }
      else if (field === 'ciudad') updateData.city = capitalizeWords(cleanText);
      else if (field === 'barrio o zona') updateData.zone = capitalizeWords(cleanText);
    }

    // Actualizar candidato si hay datos nuevos
    if (Object.keys(updateData).length > 0) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: updateData
      });
    }

    // Consultar estado actualizado del candidato
    const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const missing = getMissingFields(updatedCandidate);

    if (missing.length === 0) {
      // Todos los datos completos — pasar a confirmación
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { currentStep: ConversationStep.CONFIRMING_DATA }
      });
      await reply(prisma, candidate.id, from, buildConfirmationMessage(updatedCandidate));
    } else {
      // Aún faltan datos
      if (Object.keys(updateData).length > 0) {
        // Se recibieron datos parciales, pedir los faltantes
        await reply(prisma, candidate.id, from, buildMissingFieldsMessage(updatedCandidate, missing));
      } else {
        // No se detectó ningún dato — orientar al candidato
        await reply(
          prisma, candidate.id, from,
          `No logré identificar los datos en tu mensaje. ${buildMissingFieldsMessage(updatedCandidate, missing)}\n\nPuedes enviarlos como prefieras, por ejemplo: "Juan Pérez, CC 1234567890, 25 años, Ibagué, barrio Centro".`
        );
      }
    }
    return;
  }

  // ── CONFIRMING_DATA: Esperando confirmación del candidato ──
  if (candidate.currentStep === ConversationStep.CONFIRMING_DATA) {
    const n = cleanText.toLowerCase();

    // Si confirma los datos
    if (/^(s[ií]|correcto|est[áa] bien|confirmo|listo|dale|ok|okay|perfecto|todo bien)$/i.test(n) ||
        /\bs[ií]\b/.test(n) && n.length < 30) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.ASK_CV,
          status: CandidateStatus.REGISTRADO
        }
      });

      const nombre = candidate.fullName ? candidate.fullName.split(' ')[0] : '';
      await reply(
        prisma, candidate.id, from,
        `¡Listo${nombre ? ' ' + nombre : ''}! Tu información ha sido registrada correctamente.\n\n${MENSAJE_PREGUNTAR_CV}`
      );
      return;
    }

    // Si quiere corregir los datos
    if (/^(no|negativo|incorrecto|mal|est[áa] mal|cambiar|corregir)/i.test(n)) {
      // Limpiar datos del candidato y volver a COLLECTING_DATA
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          fullName: null,
          documentType: null,
          documentNumber: null,
          age: null,
          city: null,
          zone: null,
          currentStep: ConversationStep.COLLECTING_DATA
        }
      });

      await reply(
        prisma, candidate.id, from,
        'Sin problema, vamos de nuevo. Por favor envíame tus datos:\n\n- Nombre completo\n- Tipo y número de documento\n- Edad\n- Ciudad\n- Barrio o zona'
      );
      return;
    }

    // Si la respuesta no es clara
    await reply(
      prisma, candidate.id, from,
      'Por favor responde *sí* si los datos son correctos, o *no* si deseas corregirlos.'
    );
    return;
  }
}

// ─────────────────────────────────────────────────────────
// Router principal del webhook
// ─────────────────────────────────────────────────────────

export function webhookRouter(prisma) {
  const router = express.Router();

  // Endpoint GET para verificación del webhook por Meta.
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Endpoint POST que recibe mensajes reales desde Meta.
  router.post('/', async (req, res, next) => {
    try {
      const messages = extractMessages(req.body);

      if (!messages.length) {
        return res.sendStatus(200);
      }

      for (const message of messages) {
        const from = message.from;
        if (!from) continue;

        // Busca o crea el candidato asociado al teléfono.
        const candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });

        // Procesar mensajes de texto.
        if (message.type === 'text') {
          const wasNew = await saveInboundMessage(
            prisma, candidate.id, message,
            message.text?.body || '', MessageType.TEXT
          );
          if (!wasNew) continue;

          const freshCandidate = await prisma.candidate.findUnique({
            where: { id: candidate.id }
          });
          await processText(prisma, freshCandidate, from, message.text?.body || '');
          continue;
        }

        // Guardar cualquier otro tipo de mensaje para auditoría.
        const bodyForLog = message.document?.filename || '';
        const typeForLog = message.type === 'document' ? MessageType.DOCUMENT : MessageType.UNKNOWN;
        const wasNew = await saveInboundMessage(prisma, candidate.id, message, bodyForLog, typeForLog);
        if (!wasNew) continue;

        // Refrescar el candidato para tener el step actualizado.
        const freshCandidateForDoc = await prisma.candidate.findUnique({
          where: { id: candidate.id }
        });

        // Si el candidato está en ASK_CV y envía un documento, validar formato y guardar CV.
        if (freshCandidateForDoc.currentStep === ConversationStep.ASK_CV && message.type === 'document') {
          const mime = (message.document.mime_type || '').toLowerCase();
          const validCV = mime === 'application/pdf'
            || mime === 'application/msword'
            || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

          if (!validCV) {
            await reply(
              prisma, candidate.id, from,
              'El archivo debe ser en formato PDF o Word. Por favor envíalo nuevamente.'
            );
            continue;
          }

          try {
            const mediaId = message.document.id;
            const metadata = await fetchMediaMetadata(mediaId);
            const buffer = await downloadMedia(metadata.url);

            await prisma.candidate.update({
              where: { id: candidate.id },
              data: {
                cvOriginalName: message.document.filename || 'documento',
                cvMimeType: message.document.mime_type || 'application/octet-stream',
                cvData: buffer,
                currentStep: ConversationStep.DONE
              }
            });

            await reply(
              prisma, candidate.id, from,
              `${MENSAJE_CV_RECIBIDO}\n\nRecuerda que la entrevista se realizará el *8 de abril*. Debes estar atento/a al llamado o aviso donde te confirmaremos el lugar y la hora exacta.\n\n¡Mucho éxito en el proceso!`
            );
          } catch (err) {
            console.error('Error descargando CV:', err.message);
            await reply(
              prisma, candidate.id, from,
              'Hubo un problema al recibir tu archivo. ¿Podrías intentar enviarlo de nuevo?'
            );
          }
          continue;
        }

        // Si el candidato está en ASK_CV y envía media no-documento (imagen, audio, etc.)
        if (freshCandidateForDoc.currentStep === ConversationStep.ASK_CV && message.type !== 'document') {
          await reply(
            prisma, candidate.id, from,
            'El archivo debe ser en formato PDF o Word. Por favor envíalo nuevamente.'
          );
          continue;
        }

        // Responder según el estado del candidato.
        if (freshCandidateForDoc.currentStep === ConversationStep.DONE) {
          await reply(prisma, candidate.id, from, MENSAJE_YA_REGISTRADO);
        } else {
          await reply(
            prisma, candidate.id, from,
            'Por ahora solo puedo procesar mensajes de texto. Por favor escríbeme tus datos en un mensaje.'
          );
        }
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
