// Importa Express para crear el router del panel administrativo.
import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';

// Middleware de autenticación por sesión para proteger el dashboard.
function sessionAuth(req, res, next) {
  const role = req.session?.userRole;

  if (!role) {
    return res.redirect('/login');
  }

  req.userRole = role;
  return next();
}

// Normaliza strings de formularios: trim y null si queda vacío.
function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// Formatea fechas para el dashboard en zona horaria de Colombia (Bogotá).
function formatDateTimeCO(value) {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

// Mapeo de estados enum a texto legible.
const STATUS_LABELS = {
  'NUEVO': 'Nuevo',
  'REGISTRADO': 'Registrado',
  'VALIDANDO': 'En revisión',
  'APROBADO': 'Aprobado',
  'RECHAZADO': 'Rechazado',
  'CONTACTADO': 'Contactado'
};

const ALLOWED_CV_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const ALLOWED_CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);

function buildCvStatusQuery(type, message) {
  const params = new URLSearchParams();
  params.set(type, message);
  return params.toString();
}

function isAllowedCvFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  return ALLOWED_CV_MIMES.has(file.mimetype) && ALLOWED_CV_EXTENSIONS.has(extension);
}

function parseContentDisposition(disposition) {
  const nameMatch = disposition.match(/name="([^"]+)"/i);
  const filenameMatch = disposition.match(/filename="([^"]*)"/i);
  return {
    fieldName: nameMatch?.[1] || null,
    filename: filenameMatch?.[1] || null
  };
}

async function readRawBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Archivo demasiado grande');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseSingleMultipartFile(req, fieldName) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) return null;

  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const body = await readRawBody(req);
  const segments = [];
  let start = body.indexOf(boundary);

  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    segments.push(body.subarray(start + boundary.length, next));
    start = next;
  }

  for (const rawSegment of segments) {
    let segment = rawSegment;
    if (segment.subarray(0, 2).equals(Buffer.from('\r\n'))) {
      segment = segment.subarray(2);
    }
    if (!segment.length || segment.equals(Buffer.from('--\r\n'))) continue;

    const headersEnd = segment.indexOf(Buffer.from('\r\n\r\n'));
    if (headersEnd === -1) continue;

    const headersRaw = segment.subarray(0, headersEnd).toString('utf8');
    const contentStart = headersEnd + 4;
    let contentEnd = segment.length;
    if (segment.subarray(contentEnd - 2, contentEnd).equals(Buffer.from('\r\n'))) {
      contentEnd -= 2;
    }
    const fileBuffer = segment.subarray(contentStart, contentEnd);
    const headerLines = headersRaw.split('\r\n');
    const headers = {};
    for (const line of headerLines) {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) continue;
      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      headers[key] = value;
    }

    const disposition = headers['content-disposition'];
    if (!disposition) continue;
    const parsedDisposition = parseContentDisposition(disposition);
    if (parsedDisposition.fieldName !== fieldName || !parsedDisposition.filename) continue;

    return {
      fieldname: fieldName,
      originalname: parsedDisposition.filename,
      mimetype: headers['content-type'] || 'application/octet-stream',
      buffer: fileBuffer,
      size: fileBuffer.length
    };
  }

  return null;
}

// Expone el router administrativo.
export function adminRouter(prisma) {
  const router = express.Router();

  // Protege todas las rutas del dashboard con autenticación por sesión.
  router.use(sessionAuth);


  // Ruta principal: listado de candidatos.
  router.get('/', async (req, res) => {
    const candidates = await prisma.candidate.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    res.render('list', { candidates, formatDateTimeCO, role: req.userRole });
  });

  // Ruta de detalle de un candidato con historial de mensajes.
  router.get('/candidates/:id', async (req, res) => {
    const includeMessages = req.userRole === 'dev';
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      include: includeMessages ? {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 50
        }
      } : undefined
    });

    if (!candidate) {
      return res.status(404).send('Candidato no encontrado');
    }

    const cvError = normalizeString(req.query.cvError);
    const cvSuccess = normalizeString(req.query.cvSuccess);
    res.render('detail', { candidate, formatDateTimeCO, role: req.userRole, cvError, cvSuccess });
  });

  // Ruta para edición manual de datos del candidato desde el panel.
  router.post('/candidates/:id/edit', express.urlencoded({ extended: true }), async (req, res) => {
    const fullName = normalizeString(req.body.fullName);
    const documentType = normalizeString(req.body.documentType);
    const documentNumber = normalizeString(req.body.documentNumber);
    const neighborhood = normalizeString(req.body.neighborhood);
    const experienceInfo = normalizeString(req.body.experienceInfo);
    const transportMode = normalizeString(req.body.transportMode);
    const status = normalizeString(req.body.status);

    let experienceTime = normalizeString(req.body.experienceTime);
    if (experienceInfo === 'No' && !experienceTime) {
      experienceTime = '0';
    }

    let medicalRestrictions = normalizeString(req.body.medicalRestrictions);
    const normalizedRestrictions = medicalRestrictions ? medicalRestrictions.toLowerCase() : '';
    if (['ninguna', 'no', 'sin restricciones'].includes(normalizedRestrictions)) {
      medicalRestrictions = 'Sin restricciones médicas';
    }

    const rawAge = typeof req.body.age === 'string' ? req.body.age.trim() : '';
    let age = null;
    if (rawAge !== '') {
      const parsedAge = Number.parseInt(rawAge, 10);
      age = Number.isNaN(parsedAge) ? null : parsedAge;
    }

    await prisma.candidate.update({
      where: { id: req.params.id },
      data: {
        fullName,
        documentType,
        documentNumber,
        age,
        neighborhood,
        experienceInfo,
        experienceTime,
        medicalRestrictions,
        transportMode,
        status
      }
    });

    res.redirect(`/admin/candidates/${req.params.id}`);
  });

  // Ruta para actualizar el estado del candidato desde el panel.
  router.post('/candidates/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    await prisma.candidate.update({
      where: { id: req.params.id },
      data: { status: req.body.status }
    });
    res.redirect(`/admin/candidates/${req.params.id}`);
  });

  // Ruta para descargar la hoja de vida de un candidato.
  router.get('/candidates/:id/cv', async (req, res) => {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      select: { cvData: true, cvOriginalName: true, cvMimeType: true }
    });

    if (!candidate || !candidate.cvData) {
      return res.status(404).send('Hoja de vida no encontrada');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${candidate.cvOriginalName || 'hoja_de_vida'}"`);
    res.setHeader('Content-Type', candidate.cvMimeType || 'application/octet-stream');
    res.send(candidate.cvData);
  });

  // Ruta para carga/reemplazo manual de hoja de vida desde el dashboard.
  router.post('/candidates/:id/cv/upload', async (req, res) => {
    const candidateId = req.params.id;
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, cvData: true }
    });

    if (!candidate) {
      return res.status(404).send('Candidato no encontrado');
    }

    let file = null;
    try {
      file = await parseSingleMultipartFile(req, 'cvFile');
    } catch (error) {
      console.warn('[CV_MANUAL_INVALID]', JSON.stringify({ candidateId, role: req.userRole, reason: 'file_too_large' }));
      const query = buildCvStatusQuery('cvError', 'El archivo supera el tamaño máximo permitido (10MB).');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }

    if (!file) {
      console.warn('[CV_MANUAL_INVALID]', JSON.stringify({ candidateId, role: req.userRole, reason: 'missing_file' }));
      const query = buildCvStatusQuery('cvError', 'Debes seleccionar un archivo PDF, DOC o DOCX.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }

    if (!isAllowedCvFile(file)) {
      console.warn('[CV_MANUAL_INVALID]', JSON.stringify({
        candidateId,
        role: req.userRole,
        reason: 'invalid_type',
        mimeType: file.mimetype,
        filename: file.originalname
      }));
      const query = buildCvStatusQuery('cvError', 'Archivo inválido. Solo se permiten PDF, DOC o DOCX.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }

    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        cvData: file.buffer,
        cvOriginalName: file.originalname,
        cvMimeType: file.mimetype
      }
    });

    const action = candidate.cvData ? '[CV_MANUAL_REPLACE]' : '[CV_MANUAL_UPLOAD]';
    console.log(action, JSON.stringify({
      candidateId,
      role: req.userRole,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size
    }));

    const successMessage = candidate.cvData
      ? 'Hoja de vida reemplazada correctamente.'
      : 'Hoja de vida cargada correctamente.';
    const query = buildCvStatusQuery('cvSuccess', successMessage);
    return res.redirect(`/admin/candidates/${candidateId}?${query}`);
  });

  // Ruta para eliminar hoja de vida manualmente desde el dashboard.
  router.post('/candidates/:id/cv/delete', async (req, res) => {
    const candidateId = req.params.id;
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, cvData: true }
    });

    if (!candidate) {
      return res.status(404).send('Candidato no encontrado');
    }

    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        cvData: null,
        cvOriginalName: null,
        cvMimeType: null
      }
    });

    console.log('[CV_MANUAL_DELETE]', JSON.stringify({
      candidateId,
      role: req.userRole,
      hadCv: Boolean(candidate.cvData)
    }));

    const query = buildCvStatusQuery('cvSuccess', 'Hoja de vida eliminada correctamente.');
    return res.redirect(`/admin/candidates/${candidateId}?${query}`);
  });

  // Ruta para exportar candidatos a Excel.
  router.get('/export', async (_req, res) => {
    const candidates = await prisma.candidate.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Candidatos');

    sheet.columns = [
      { header: 'Fecha de registro', key: 'createdAt', width: 20 },
      { header: 'Nombre completo', key: 'fullName', width: 30 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Tipo documento', key: 'documentType', width: 15 },
      { header: 'Número documento', key: 'documentNumber', width: 18 },
      { header: 'Edad', key: 'age', width: 8 },
      { header: 'Barrio', key: 'neighborhood', width: 20 },
      { header: 'Experiencia', key: 'experienceInfo', width: 15 },
      { header: 'Tiempo de experiencia', key: 'experienceTime', width: 20 },
      { header: 'Restricciones médicas', key: 'medicalRestrictions', width: 25 },
      { header: 'Medio de transporte', key: 'transportMode', width: 20 },
      { header: 'Estado', key: 'status', width: 15 },
      { header: 'WhatsApp', key: 'whatsapp', width: 15 }
    ];

    // Estilo del encabezado
    sheet.getRow(1).font = { bold: true };

    for (const c of candidates) {
      const row = sheet.addRow({
        createdAt: formatDateTimeCO(c.createdAt),
        fullName: c.fullName || '',
        phone: c.phone,
        documentType: c.documentType || '',
        documentNumber: c.documentNumber || '',
        age: c.age || '',
        neighborhood: c.neighborhood || c.zone || '',
        experienceInfo: c.experienceInfo || '',
        experienceTime: c.experienceTime || '',
        medicalRestrictions: c.medicalRestrictions || '',
        transportMode: c.transportMode || '',
        status: STATUS_LABELS[c.status] || c.status,
        whatsapp: 'Escribir'
      });

      // Teléfono como texto
      row.getCell('phone').numFmt = '@';
      row.getCell('documentNumber').numFmt = '@';

      // Hipervínculo clickeable a WhatsApp
      row.getCell('whatsapp').value = {
        text: 'Escribir',
        hyperlink: `https://wa.me/${c.phone}`
      };
      row.getCell('whatsapp').font = { color: { argb: 'FF0066CC' }, underline: true };
    }

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="candidatos_${today}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  });

  // Vista de monitor en tiempo real (solo dev).
  router.get('/monitor', async (req, res) => {
    if (req.userRole !== 'dev') {
      return res.status(403).send('Acceso restringido a desarrolladores');
    }
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        candidate: {
          select: { phone: true, fullName: true, currentStep: true }
        }
      }
    });
    res.render('monitor', { messages, formatDateTimeCO, role: req.userRole });
  });

  // API JSON del monitor (solo dev).
  router.get('/monitor/api', async (req, res) => {
    if (req.userRole !== 'dev') {
      return res.status(403).json({ error: 'Acceso restringido a desarrolladores' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        candidate: {
          select: { phone: true, fullName: true, currentStep: true }
        }
      }
    });

    const result = messages.map(m => {
      const trace = m.rawPayload?.debugTrace || null;
      return {
        timestamp: m.createdAt,
        phone: m.candidate.phone,
        candidateName: m.candidate.fullName || '',
        direction: m.direction,
        body: m.body || '',
        currentStep: m.candidate.currentStep,
        debugTrace: trace ? {
          openai_status: trace.openai_status,
          openai_intent: trace.openai_intent,
          openai_detected_fields: trace.openai_detected_fields || [],
          persisted_fields: trace.persisted_fields || [],
          rejected_fields: trace.rejected_fields || [],
          cv_detected: Boolean(trace.cv_detected),
          cv_saved: Boolean(trace.cv_saved),
          cv_invalid_mime: Boolean(trace.cv_invalid_mime),
          cv_download_failed: Boolean(trace.cv_download_failed),
          error_summary: trace.error_summary || null
        } : null
      };
    });

    res.json(result);
  });

  return router;
}
