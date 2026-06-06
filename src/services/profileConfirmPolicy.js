export function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function getProfileValue(profile = {}, field = '') {
  if (field === 'residence') return profile.locality || profile.neighborhood || profile.zone || null;
  return profile[field];
}

export function isProfileComplete(profile = {}, requiredFields = []) {
  return requiredFields.every((field) => hasValue(getProfileValue(profile, field)));
}

export function getMissingProfileFields(profile = {}, requiredFields = []) {
  return requiredFields.filter((field) => !hasValue(getProfileValue(profile, field)));
}

export function shouldConfirmOnce({ profile = {}, requiredFields = [], alreadyConfirming = false, confirmationAccepted = false } = {}) {
  if (confirmationAccepted) return false;
  if (alreadyConfirming) return false;
  return isProfileComplete(profile, requiredFields);
}
