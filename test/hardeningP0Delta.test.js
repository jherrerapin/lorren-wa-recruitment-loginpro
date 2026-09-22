import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { runReminderDispatcher, scheduleReminderForCandidate } from '../src/services/reminder.js';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';

function createLegacyWordBuffer(text = '') {
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return Buffer.concat([signature, Buffer.alloc(16), Buffer.from(text, 'utf16le')]);
}

test('PDF ilegible se clasifica UNREADABLE y no CV_VALID', async () => {
  const buffer = Buffer.from('certificado bancario de apertura de cuenta');
  const result = await analyzeAttachment({
    buffer,
    mimeType: 'application/pdf',
    filename: 'certificado.pdf'
  });

  assert.notEqual(result.classification, 'CV_VALID');
  assert.equal(result.classification, 'UNREADABLE');
  assert.equal(result.rationale, 'text_extraction_failed');
});

test('imagen se clasifica como CV_IMAGE_ONLY pero no como CV_VALID', async () => {
  const result = await analyzeAttachment({
    buffer: Buffer.from('fake-image-content'),
    mimeType: 'image/jpeg',
    filename: 'foto.jpg'
  });

  assert.equal(result.classification, 'CV_IMAGE_ONLY');
  assert.notEqual(result.classification, 'CV_VALID');
});

test('.doc Word clásico con texto de HV se clasifica como CV válido', async () => {
  const result = await analyzeAttachment({
    buffer: createLegacyWordBuffer('Hoja de vida con perfil profesional y experiencia laboral'),
    mimeType: 'application/msword',
    filename: 'hv.doc'
  });

  assert.equal(result.classification, 'CV_VALID');
  assert.equal(result.attachmentKind, 'doc');
  assert.match(result.extractedText, /perfil profesional/i);
});

test('.doc renombrado sin contenedor Word no se acepta como CV', async () => {
  const result = await analyzeAttachment({
    buffer: Buffer.from('contenido que no es un archivo OLE de Word'),
    mimeType: 'application/msword',
    filename: 'hv.doc'
  });

  assert.equal(result.classification, 'OTHER');
  assert.equal(result.rationale, 'invalid_legacy_word_container');
});

test('scheduleReminderForCandidate encola seguimiento del proceso a dos horas', async () => {
  process.env.FF_POSTGRES_JOB_QUEUE = 'true';
  const now = new Date('2026-04-23T10:00:00.000Z');
  const candidate = {
    id: 'cand-queue-1',
    reminderState: 'NONE',
    reminderScheduledFor: null,
    status: 'NUEVO',
    currentStep: 'COLLECTING_DATA',
    botPaused: false,
    lastInboundAt: new Date('2026-04-23T09:30:00.000Z')
  };
  const updates = [];
  const jobs = [];
  const prisma = {
    candidate: {
      findUnique: async () => candidate,
      update: async ({ data }) => { updates.push(data); return { ...candidate, ...data }; }
    },
    jobQueue: {
      create: async ({ data }) => { jobs.push(data); return data; }
    }
  };

  await scheduleReminderForCandidate(prisma, candidate.id, now);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'candidate_process_reminder');
  assert.equal(new Date(jobs[0].runAt).toISOString(), '2026-04-23T12:00:00.000Z');
  assert.equal(jobs[0].dedupeKey, 'candidate:cand-queue-1:process-reminder:2026-04-23T12:00:00.000Z');
  assert.equal(updates[0].reminderState, 'SCHEDULED');
  delete process.env.FF_POSTGRES_JOB_QUEUE;
});

test('keepalive se corta si entrevista inactiva o reminder ya intentado', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  const now = new Date('2026-04-23T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-k-1',
      phone: '573001001001',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-23T20:00:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'book-k-1',
      candidateId: 'cand-k-1',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-23T22:00:00.000Z'),
      status: 'CONFIRMED',
      reminderSentAt: new Date('2026-04-23T20:30:00.000Z'),
      reminderWindowClosed: false
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
  }
});

test('runReminderDispatcher dirigido por candidateId procesa solo el candidato esperado', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  const now = new Date('2026-04-23T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [
      {
        id: 'cand-target',
        phone: '573111111111',
        status: 'NUEVO',
        currentStep: 'ASK_CV',
        reminderState: 'SCHEDULED',
        reminderScheduledFor: new Date('2026-04-23T20:00:00.000Z'),
        lastInboundAt: new Date('2026-04-23T19:00:00.000Z')
      },
      {
        id: 'cand-other',
        phone: '573222222222',
        status: 'NUEVO',
        currentStep: 'ASK_CV',
        reminderState: 'SCHEDULED',
        reminderScheduledFor: new Date('2026-04-23T20:00:00.000Z'),
        lastInboundAt: new Date('2026-04-23T19:00:00.000Z')
      }
    ]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runReminderDispatcher(prisma, { now, candidateId: 'cand-target' });
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.equal(whatsappMock.sentMessages[0].to, '573111111111');
    assert.equal(prisma.state.candidates.find((c) => c.id === 'cand-target')?.reminderState, 'SENT');
    assert.equal(prisma.state.candidates.find((c) => c.id === 'cand-other')?.reminderState, 'SCHEDULED');
  } finally {
    restoreAxios();
  }
});
