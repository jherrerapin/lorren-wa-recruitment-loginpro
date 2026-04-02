// Importa Express para crear el router del panel administrativo.
import express from 'express';
import ExcelJS from 'exceljs';

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

    res.render('detail', { candidate, formatDateTimeCO, role: req.userRole });
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

    const result = messages.map(m => ({
      timestamp: m.createdAt,
      phone: m.candidate.phone,
      candidateName: m.candidate.fullName || '',
      direction: m.direction,
      body: m.body || '',
      currentStep: m.candidate.currentStep
    }));

    res.json(result);
  });

  return router;
}
