/**
 * authUtils.js
 *
 * Utilidades de autenticación.
 *
 * Las credenciales en variables de entorno se almacenan como hashes bcrypt.
 * Nunca se compara texto plano contra texto plano.
 *
 * Para generar un hash:
 *   npm run hash-password
 * o manualmente:
 *   node -e "import('bcryptjs').then(b => b.hash('tu-password', 12).then(console.log))"
 */

import bcrypt from 'bcryptjs';

/**
 * Verifica si una contraseña en texto plano coincide con un hash bcrypt.
 * Retorna false (no lanza) si el hash está vacío o malformado.
 *
 * @param {string} plaintext  - Contraseña ingresada por el usuario
 * @param {string} hash       - Hash bcrypt almacenado en variable de entorno
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plaintext, hash) {
  if (!plaintext || !hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Genera un hash bcrypt con cost 12.
 * Usar solo en scripts de setup, nunca en el flujo de request.
 *
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, 12);
}
