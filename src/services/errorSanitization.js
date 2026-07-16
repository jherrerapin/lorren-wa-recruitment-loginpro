export function safeErrorMessage(error) {
  const message = error?.message || String(error || 'unknown_error');
  const stack = error?.stack ? `\nStack: ${error.stack}` : '';
  return `${message}${stack}`
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 1000);
}
