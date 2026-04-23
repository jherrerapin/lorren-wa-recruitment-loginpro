import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { buildPolicyReply } from '../src/services/responsePolicy.js';
import { scheduleReminderForCandidate } from '../src/services/reminder.js';

test('documento no CV se clasifica OTHER y no CV_VALID', async () => {
  const buffer = Buffer.from('certificado bancario de apertura de cuenta');
  const result = await analyzeAttachment({
    buffer,
    mimeType: 'application/pdf',
    filename: 'certificado.pdf'
  });

  assert.notEqual(result.classification, 'CV_VALID');
  assert.equal(result.classification, 'OTHER');
});

test('imagen no se clasifica automáticamente como CV_IMAGE_ONLY', async () => {
  const result = await analyzeAttachment({
    buffer: Buffer.from('fake-image-content'),
    mimeType: 'image/jpeg',
    filename: 'foto.jpg'
  });

  assert.notEqual(result.classification, 'CV_IMAGE_ONLY');
});

test('responsePolicy mantiene intención para pedir HV en PDF/Word', () => {
  const result = buildPolicyReply({ replyIntent: 'request_cv_pdf_word', recentOutbound: [] });
  assert.equal(result.intent, 'request_cv_pdf_word');
  assert.match(result.text, /PDF|Word/i);
});

test('scheduleReminderForCandidate encola reminder a una hora', async () => {
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
  assert.equal(jobs[0].type, 'interview_reminder');
  assert.equal(new Date(jobs[0].runAt).toISOString(), '2026-04-23T11:00:00.000Z');
  assert.equal(updates[0].reminderState, 'SCHEDULED');
  delete process.env.FF_POSTGRES_JOB_QUEUE;
});
