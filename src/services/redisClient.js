/**
 * redisClient.js
 *
 * Centraliza la creación del cliente Redis (ioredis) y del RedisStore
 * para express-session (connect-redis).
 *
 * Diseño:
 * - Si REDIS_URL está presente: conecta, loguea estado y exporta el cliente.
 * - Si REDIS_URL está ausente: retorna null → server.js usa MemoryStore.
 * - Los errores de conexión son no fatales: el servidor arranca igual.
 *   Un error de Redis no debe tumbar el bot en producción.
 */

import Redis from 'ioredis';
import { RedisStore } from 'connect-redis';

/**
 * Crea y conecta el cliente Redis.
 * @returns {Promise<import('ioredis').Redis|null>}
 */
export async function createRedisClient() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.warn('[REDIS] REDIS_URL no configurada. Sesiones en MemoryStore (solo desarrollo).');
    return null;
  }

  const client = new Redis(redisUrl, {
    // Reintentos con backoff exponencial hasta 30s.
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 30_000);
      console.warn(`[REDIS] Reintento de conexión #${times}, esperando ${delay}ms`);
      return delay;
    },
    // Reconexión en fallos de socket.
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some((e) => err.message.includes(e));
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false
  });

  client.on('connect', () => console.log('[REDIS] Conectado a Redis.'));
  client.on('ready', () => console.log('[REDIS] Redis listo para recibir comandos.'));
  client.on('error', (err) => console.error('[REDIS_ERROR]', err.message));
  client.on('close', () => console.warn('[REDIS] Conexión cerrada.'));
  client.on('reconnecting', () => console.warn('[REDIS] Reconectando...'));

  // Espera a que esté ready o falla silenciosamente.
  await new Promise((resolve) => {
    if (client.status === 'ready') return resolve();
    client.once('ready', resolve);
    client.once('error', resolve); // no bloquear el arranque si Redis falla
  });

  return client;
}

/**
 * Construye el store de sesiones.
 * Si no hay cliente Redis, retorna undefined → express-session usa MemoryStore.
 * @param {import('ioredis').Redis|null} redisClient
 * @returns {RedisStore|undefined}
 */
export function buildSessionStore(redisClient) {
  if (!redisClient) return undefined;

  return new RedisStore({
    client: redisClient,
    prefix: 'loginpro:sess:',
    ttl: 60 * 60 * 8     // TTL en segundos: 8 horas (alineado con maxAge de la cookie)
  });
}
