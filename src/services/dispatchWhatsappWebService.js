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

export function initDispatchWhatsappClient() {
  if (client || initializing) return client;

  initializing = true;
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'dispatch',
      dataPath: process.env.DISPATCH_WWEB_AUTH_PATH || './storage/dispatch-wweb-auth'
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
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
    lastError = error?.message || 'No fue posible inicializar WhatsApp de despacho.';
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
