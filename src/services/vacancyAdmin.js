import path from 'node:path';

const ALLOWED_AD_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AD_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function normalizeAdTextHints(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

export function isAllowedAdImageFile(file) {
  if (!file) return false;
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_AD_IMAGE_MIMES.has(file.mimetype)) return true;
  const mimeMissingOrGeneric = !file.mimetype || file.mimetype === 'application/octet-stream';
  return mimeMissingOrGeneric && ALLOWED_AD_IMAGE_EXTENSIONS.has(extension);
}

export { ALLOWED_AD_IMAGE_MIMES, ALLOWED_AD_IMAGE_EXTENSIONS };
