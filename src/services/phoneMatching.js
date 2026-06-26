export function normalizePhoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  if (digits.startsWith('57')) return digits;
  return digits;
}

export function phoneTail(value) {
  const normalized = normalizePhoneDigits(value);
  return normalized ? normalized.slice(-10) : '';
}

export function phonesMatch(left, right) {
  const normalizedLeft = normalizePhoneDigits(left);
  const normalizedRight = normalizePhoneDigits(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return phoneTail(normalizedLeft) === phoneTail(normalizedRight);
}
