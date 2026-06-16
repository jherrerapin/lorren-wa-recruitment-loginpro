import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';

const { Client, LocalAuth } = whatsappWeb;
const MAX_MESSAGE_LENGTH = 3500;
const NOT_CONNECTED_MESSAGE = 'WhatsApp de despacho no está conectado. Escanea el QR e intenta nuevamente.';

let client = null;
let initializing = false;
let ready = false;
let lastQr = null;
let lastError = null;
let lastReadyAt = null;

function buildError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  if (digits.startsWith('57')) return digits;
  return digits;
}

function normalizeMessage(message) {
  return String(message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

function executableFromPath(command) {
  try {
    const found = execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return found && fs.existsSync(found) ? found : null;
  } catch (_error) {
    return null;
  }
}

function resolveBrowserExecutablePath() {
  const explicitCandidates = [
    process.env.DISPATCH_BROWSER_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
  ].filter(Boolean);
  const explicitPath = explicitCandidates.find((candidate) => fs.existsSync(candidate));
  if (explicitPath) return explicitPath;
  return executableFromPath('chromium') || executableFromPath('chromium-browser') || executableFromPath('google-chrome-stable') || executableFromPath('google-chrome');
}

function buildPuppeteerOptions() {
  const executablePath = resolveBrowserExecutablePath();
  const options = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };
  if (executablePath) options.executablePath = executablePath;
  return options;
}

function formatBrowserLaunchError(error) {
  const rawMessage = error?.message || 'No fue posible inicializar WhatsApp de despacho.';
  if (rawMessage.includes('ENOENT') || rawMessage.includes('Could not find Chrome') || rawMessage.includes('Failed to launch the browser process')) {
    return 'No se encontró Chrome/Chromium en el servidor para iniciar la sesión de WhatsApp despacho. Configura DISPATCH_BROWSER_EXECUTABLE_PATH o PUPPETEER_EXECUTABLE_PATH con la ruta de Chrome disponible, o instala el navegador en el entorno de despliegue.';
  }
  return rawMessage;
}

export function initDispatchWhatsappClient() {
  if (client || initializing) return client;

  initializing = true;
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'dispatch',
      dataPath: process.env.DISPATCH_WWEB_AUTH_PATH || './storage/dispatch-wweb-auth'
    }),
    puppeteer: buildPuppeteerOptions()
  });

  client.on('qr', (qr) => {
    lastQr = qr;
    ready = false;
    lastError = null;
    console.log('QR de WhatsApp despacho pendiente. Escanéalo para vincular la sesión:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    ready = true;
    lastQr = null;
    lastError = null;
    lastReadyAt = new Date().toISOString();
    console.log('WhatsApp de despacho conectado.');
  });

  client.on('disconnected', (reason) => {
    ready = false;
    lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.';
    console.warn(lastError);
  });

  client.on('auth_failure', (message) => {
    ready = false;
    lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.';
    console.warn(lastError);
  });

  client.initialize().catch((error) => {
    ready = false;
    lastQr = null;
    lastError = formatBrowserLaunchError(error);
    client = null;
    console.error('Error inicializando WhatsApp de despacho.', error);
  }).finally(() => {
    initializing = false;
  });

  return client;
}

export function getDispatchWhatsappStatus() {
  return { ready, lastQr, lastError, lastReadyAt };
}

export async function getDispatchWhatsappStatusView() {
  const qrImage = lastQr ? await QRCode.toDataURL(lastQr) : null;
  return { ready, lastQr, qrImage, lastError, lastReadyAt };
}

export async function sendDispatchWhatsappMessage({ phone, message }) {
  const normalizedPhone = normalizePhone(phone);
  const normalizedMessage = normalizeMessage(message);

  if (!normalizedPhone) throw buildError('Debes indicar un número válido para enviar WhatsApp.', 400);
  if (normalizedPhone.length < 11 || normalizedPhone.length > 15) throw buildError('El número de WhatsApp no es válido.', 400);
  if (!normalizedMessage) throw buildError('El mensaje de WhatsApp no puede estar vacío.', 400);
  if (/<[^>]+>/.test(normalizedMessage)) throw buildError('El mensaje de WhatsApp no puede contener HTML.', 400);
  if (!client) initDispatchWhatsappClient();
  if (!ready) throw buildError(NOT_CONNECTED_MESSAGE, 503);

  const numberId = await client.getNumberId(normalizedPhone);
  if (!numberId?._serialized) throw buildError('El número no está disponible en WhatsApp.', 400);

  const sent = await client.sendMessage(numberId._serialized, normalizedMessage);
  return {
    phone: normalizedPhone,
    providerMessageId: sent?.id?._serialized || sent?.id?.id || null
  };
}
