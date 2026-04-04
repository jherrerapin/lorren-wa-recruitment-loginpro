/**
 * reminder.js
 *
 * Dispatcher de recordatorios: inactividad de candidatos + entrevistas próximas.
 *
 * Sprint 6 — lock distribuido con Redis:
 * Antes de ejecutar cada tick, el pod intenta adquirir un lock exclusivo
 * en Redis usando SET NX PX. Si otro pod ya tiene el lock, este cede
 * silenciosamente. Esto resuelve el problema de multi-pod donde múltiples
 * instancias disparan el mismo recordatorio en paralelo.
 *
 * Si Redis no está disponible (redisClient null o error), el dispatcher
 * corre sin lock (comportamiento anterior). Esto garantiza que la falta
 * de Redis no deje los recordatorios sin ejecutarse.
 */

import { sendTextMessage } from './whatsapp.js';
import { findInterviewsDueForReminder, buildReminderMessage } from './interviewFlow.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const INACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;        // 24h sin actividad
const REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;         // 6h entre recordatorios
const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;  // ventana de 24h de WhatsApp

const INACTIVITY_STEPS_ELIGIBLE = new Set([
  'COLLECTING_DATA',
  'CONFIRMING_DATA',
  'ASK_CV'
]);

// TTL del lock: 55s (< intervalo del setInterval de 60s para evitar starvation)
const LOCK_TTL_MS = 55_000;
const LOCK_KEY_INACTIVITY = 'loginpro:lock:reminder:inactivity';
const LOCK_KEY_INTERVIEW  = 'loginpro:lock:reminder:interview';

// ─── LOCK DISTRIBUIDO ────────────────────────────────────────────────────────

/**
 * Intenta adquirir un lock Redis exclusivo.
 * @param {import('ioredis').Redis|null} redisClient
 * @param {string} key
 * @returns {Promise<boolean>} true si se obtuvo el lock
 */
async function acquireLock(redisClient, key) {
  if (!redisClient || redisClient.status !== 'ready') return true; // sin Redis, siempre ejecutar
  try {
    const result = await redisClient.set(key, '1', 'NX', 'PX', LOCK_TTL_MS);
    return result === 'OK';
  } catch (err) {
    console.warn(`[LOCK_WARN] No se pudo verificar lock ${key}:`, err.message);
    return true; // en caso de error Redis, ejecutar igualmente
  }
}

/**
 * Libera el lock Redis.
 * @param {import('ioredis').Redis|null} redisClient
 * @param {string} key
 */
async function releaseLock(redisClient, key) {
  if (!redisClient || redisClient.status !== 'ready') return;
  try {
    await redisClient.del(key);
  } catch (err) {
    console.warn(`[LOCK_WARN] No se pudo liberar lock ${key}:`, err.message);
  }
}

// ─── DISPATCHER DE INACTIVIDAD ───────────────────────────────────────────────

async function dispatchInactivityReminders(prisma) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - INACTIVITY_WINDOW_MS);
  const cooldownCutoff = new Date(now.getTime() - REMINDER_COOLDOWN_MS);

  const candidates = await prisma.candidate.findMany({
    where: {
      currentStep: { in: [...INACTIVITY_STEPS_ELIGIBLE] },
      botPaused: { not: true },
      lastActivityAt: { lt: cutoff },
      OR: [
        { lastReminderSentAt: null },
        { lastReminderSentAt: { lt: cooldownCutoff } }
      ]
    },
    select: {
      id: true,
      phone: true,
      fullName: true,
      currentStep: true,
      lastActivityAt: true
    },
    take: 50
  });

  for (const candidate of candidates) {
    try {
      const lastInbound = await prisma.message.findFirst({
        where: { candidateId: candidate.id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true }
      });

      const lastInboundAt = lastInbound?.createdAt;
      const withinWindow = lastInboundAt &&
        (now.getTime() - new Date(lastInboundAt).getTime()) <= WHATSAPP_SESSION_WINDOW_MS;

      if (!withinWindow) {
        console.log(`[REMINDER_SKIP] ${candidate.phone} — fuera de ventana WhatsApp`);
        continue;
      }

      const message = '¡Hola! 👋 Veo que tu proceso de postulación sigue pendiente. Si deseas continuar, responde este mensaje y con gusto te ayudo.';
      await sendTextMessage(candidate.phone, message);

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { lastReminderSentAt: now }
      });

      console.log(`[REMINDER_SENT] inactividad → ${candidate.phone}`);
    } catch (err) {
      console.error(`[REMINDER_ERROR] ${candidate.phone}:`, err.message);
    }
  }
}

// ─── DISPATCHER DE ENTREVISTAS ───────────────────────────────────────────────

async function dispatchInterviewReminders(prisma) {
  const dueInterviews = await findInterviewsDueForReminder(prisma);

  for (const interview of dueInterviews) {
    try {
      const message = buildReminderMessage(interview);
      await sendTextMessage(interview.candidate.phone, message);

      await prisma.interview.update({
        where: { id: interview.id },
        data: { reminderSentAt: new Date() }
      });

      console.log(`[INTERVIEW_REMINDER_SENT] → ${interview.candidate.phone} (interview ${interview.id})`);
    } catch (err) {
      console.error(`[INTERVIEW_REMINDER_ERROR] interview ${interview.id}:`, err.message);
    }
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

/**
 * Punto de entrada del dispatcher.
 * Recibe opciones con el cliente Redis para el lock distribuido.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ redisClient?: import('ioredis').Redis|null }} [opts]
 */
export async function runReminderDispatcher(prisma, opts = {}) {
  const { redisClient = null } = opts;

  // ── Job 1: recordatorios de inactividad ──
  const gotInactivityLock = await acquireLock(redisClient, LOCK_KEY_INACTIVITY);
  if (gotInactivityLock) {
    try {
      await dispatchInactivityReminders(prisma);
    } finally {
      await releaseLock(redisClient, LOCK_KEY_INACTIVITY);
    }
  } else {
    console.log('[REMINDER_SKIP] Inactividad: otro pod tiene el lock.');
  }

  // ── Job 2: recordatorios de entrevistas ──
  const gotInterviewLock = await acquireLock(redisClient, LOCK_KEY_INTERVIEW);
  if (gotInterviewLock) {
    try {
      await dispatchInterviewReminders(prisma);
    } finally {
      await releaseLock(redisClient, LOCK_KEY_INTERVIEW);
    }
  } else {
    console.log('[REMINDER_SKIP] Entrevistas: otro pod tiene el lock.');
  }
}
