import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import ejs from 'ejs';

async function renderDetail(role = 'admin') {
  const template = await fs.readFile(path.resolve(process.cwd(), 'src/views/detail.ejs'), 'utf8');
  const candidate = {
    id: 'candidate-1',
    fullName: 'Laura Gomez',
    phone: '573001112233',
    status: 'REGISTRADO',
    currentStep: 'SCHEDULED',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 29,
    neighborhood: 'Centro',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    createdAt: new Date('2026-04-09T12:00:00.000Z'),
    lastInboundAt: new Date('2026-04-09T12:00:00.000Z'),
    gender: 'UNKNOWN',
    botPaused: false,
    interviewNotes: '',
    vacancyId: 'vacancy-1',
    vacancy: {
      id: 'vacancy-1',
      title: 'Auxiliar de Bodega',
      role: 'Auxiliar de Bodega',
      city: 'Siberia',
      schedulingEnabled: true,
      interviewAddress: 'Calle 80 # 1-20'
    },
    interviewBookings: [{
      id: 'booking-1',
      status: 'SCHEDULED',
      scheduledAt: new Date('2026-04-10T15:00:00.000Z'),
      vacancy: { title: 'Auxiliar de Bodega', role: 'Auxiliar de Bodega', city: 'Siberia' }
    }],
    messages: [],
    recruiterEvents: [],
    recruiterActions: [],
    hasCv: true
  };

  return ejs.render(template, {
    role,
    canManageUsers: false,
    candidate,
    cvSizeBytes: 0,
    adminEvents: [],
    returnToPath: '/admin',
    availableVacancies: [],
    availableInterviewSlots: [{
      slot: { id: 'slot-1' },
      date: new Date('2026-04-10T16:00:00.000Z'),
      formattedDate: 'viernes 10 de abril, 11:00 a. m.',
      windowOk: true
    }],
    outboundWindow: { isOpen: true, expiringSoon: false },
    cvSuccess: null,
    cvError: null,
    outboundSuccess: null,
    outboundError: null,
    botPauseSuccess: null,
    botPauseError: null,
    bookingSuccess: null,
    bookingError: null,
    isFemaleHumanReviewCandidate: () => false,
    normalizeCandidateStatusForUI: (value) => value,
    formatDateTimeCO: () => '09/04/2026 12:00',
    formatActorRoleLabel: (value) => value,
    formatAdminEventLabel: (value) => value
  }, {
    filename: path.resolve(process.cwd(), 'src/views/detail.ejs')
  });
}

test('detail entrevista recruiter muestra solo asistio, no asistio y reagendo', async () => {
  const html = await renderDetail('admin');
  assert.match(html, /Asisti/);
  assert.match(html, /No asisti/);
  assert.match(html, /Reagend/);
  assert.match(html, /Nueva fecha y hora de entrevista/);
  assert.doesNotMatch(html, />\s*Cancel[oó]\s*</);
  assert.doesNotMatch(html, /No contesta/);
  assert.doesNotMatch(html, /Eliminar agendamiento/);
});

test('detail entrevista dev mantiene todas las acciones manuales', async () => {
  const html = await renderDetail('dev');
  assert.match(html, /Cancel/);
  assert.match(html, /No contesta/);
  assert.match(html, /Eliminar agendamiento/);
});
