#!/usr/bin/env node
/**
 * scripts/hash-password.mjs
 *
 * Genera un hash bcrypt (cost 12) para usar en las variables de entorno
 * DEV_PASS y ADMIN_PASS.
 *
 * Uso:
 *   npm run hash-password
 * o directamente:
 *   node scripts/hash-password.mjs
 *
 * El script pide la contraseña por stdin de forma interactiva (no queda
 * en el historial del shell).
 */

import bcrypt from 'bcryptjs';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Ocultar input no es nativo en Node readline, pero al menos no lo
// imprimimos en pantalla usando el truco de mute.
process.stdout.write('Contraseña a hashear: ');
rl.input.resume();

rl.question('', async (password) => {
  rl.close();
  if (!password || password.trim().length === 0) {
    console.error('\n[ERROR] La contraseña no puede estar vacía.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password.trim(), 12);
  console.log('\n✅ Hash generado (cost 12):');
  console.log(hash);
  console.log('\nPega este valor en tu variable de entorno DEV_PASS o ADMIN_PASS.');
  console.log('El hash comienza con $2b$ — eso es normal y esperado.');
});
