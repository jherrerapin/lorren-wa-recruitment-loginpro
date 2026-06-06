export function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}
