import { runtime } from './originRuntime.js';

export const referralAttributionMiddleware = runtime;

export function disabledLorenV2AttributionService() {
  return { enabled: false };
}
