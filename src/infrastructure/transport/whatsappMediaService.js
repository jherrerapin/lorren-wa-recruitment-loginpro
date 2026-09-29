import axios from 'axios';

const DEFAULT_GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_GRAPH_API_VERSION = 'v23.0';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export class WhatsAppMediaDownloadError extends Error {
  constructor(phase, details = {}) {
    const status = Number.isInteger(details.status) ? ` HTTP ${details.status}` : '';
    super(`WhatsApp media ${phase} failed.${status}`);
    this.name = 'WhatsAppMediaDownloadError';
    this.phase = phase;
    this.status = details.status ?? null;
    this.providerCode = details.providerCode ?? null;
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanBaseUrl(value) {
  const raw = requireNonEmptyString(value, 'graphApiBaseUrl').replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new TypeError('graphApiBaseUrl must use HTTPS');
  return url.toString().replace(/\/$/, '');
}

function cleanVersion(value) {
  const version = requireNonEmptyString(value, 'graphApiVersion');
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new TypeError('graphApiVersion must use the vXX.X format');
  }
  return version;
}

function temporaryMediaUrl(value) {
  const raw = requireNonEmptyString(value, 'Meta media URL');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new TypeError('Meta media URL must use HTTPS');
  return url.toString();
}

function errorDetails(error) {
  return {
    status: Number.isInteger(error?.response?.status) ? error.response.status : null,
    providerCode: error?.response?.data?.error?.code ?? null
  };
}

/**
 * Resolve Meta's short-lived media URL and download its binary content.
 * The access token is sent only through the Authorization header and is never
 * copied into returned values or error messages.
 */
export async function downloadWhatsappMedia(mediaId, dependencies = {}) {
  const normalizedMediaId = requireNonEmptyString(mediaId, 'mediaId');
  const token = requireNonEmptyString(
    dependencies.token ?? process.env.WHATSAPP_TOKEN,
    'WHATSAPP_TOKEN'
  );
  const graphApiBaseUrl = cleanBaseUrl(
    dependencies.graphApiBaseUrl
      ?? process.env.WHATSAPP_GRAPH_API_BASE_URL
      ?? DEFAULT_GRAPH_API_BASE_URL
  );
  const graphApiVersion = cleanVersion(
    dependencies.graphApiVersion
      ?? process.env.WHATSAPP_GRAPH_API_VERSION
      ?? DEFAULT_GRAPH_API_VERSION
  );
  const maxMediaBytes = positiveInteger(
    dependencies.maxMediaBytes ?? process.env.WHATSAPP_MAX_MEDIA_BYTES,
    DEFAULT_MAX_MEDIA_BYTES
  );
  const httpClient = dependencies.httpClient ?? axios;
  const headers = { Authorization: `Bearer ${token}` };
  const metadataUrl = `${graphApiBaseUrl}/${graphApiVersion}/${encodeURIComponent(normalizedMediaId)}`;

  let downloadUrl;
  try {
    const metadataResponse = await httpClient.get(metadataUrl, {
      headers,
      timeout: REQUEST_TIMEOUT_MS
    });
    downloadUrl = temporaryMediaUrl(metadataResponse?.data?.url);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new WhatsAppMediaDownloadError('metadata lookup', errorDetails(error));
  }

  try {
    const mediaResponse = await httpClient.get(downloadUrl, {
      headers,
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: maxMediaBytes,
      maxBodyLength: maxMediaBytes
    });
    const buffer = Buffer.isBuffer(mediaResponse?.data)
      ? mediaResponse.data
      : Buffer.from(mediaResponse?.data ?? []);
    if (!buffer.length) throw new Error('empty_media_response');
    if (buffer.length > maxMediaBytes) throw new Error('media_size_limit_exceeded');
    return buffer;
  } catch (error) {
    if (error instanceof WhatsAppMediaDownloadError) throw error;
    throw new WhatsAppMediaDownloadError('download', errorDetails(error));
  }
}

export const whatsappMediaService = Object.freeze({ downloadWhatsappMedia });

export default whatsappMediaService;
