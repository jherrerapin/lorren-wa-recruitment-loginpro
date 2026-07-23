const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const FEATURE_FLAG_DEFAULTS = Object.freeze({
  FF_RESPONSES_EXTRACTOR: true,
  FF_POLICY_LAYER: false,
  FF_POSTGRES_JOB_QUEUE: false,
  FF_ATTACHMENT_ANALYZER: false,
  FF_ASYNC_ADMIN_MEDIA_FORWARD: false
});

export function getFeatureFlagDefault(name) {
  return Object.hasOwn(FEATURE_FLAG_DEFAULTS, name)
    ? FEATURE_FLAG_DEFAULTS[name]
    : false;
}

export function isFeatureEnabled(name, fallback = getFeatureFlagDefault(name)) {
  const raw = process.env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return TRUE_VALUES.has(String(raw).trim().toLowerCase());
}

export function getHardeningFlags() {
  return {
    responsesExtractor: isFeatureEnabled('FF_RESPONSES_EXTRACTOR'),
    policyLayer: isFeatureEnabled('FF_POLICY_LAYER'),
    postgresJobQueue: isFeatureEnabled('FF_POSTGRES_JOB_QUEUE'),
    attachmentAnalyzer: isFeatureEnabled('FF_ATTACHMENT_ANALYZER'),
    asyncAdminMediaForward: isFeatureEnabled('FF_ASYNC_ADMIN_MEDIA_FORWARD')
  };
}
