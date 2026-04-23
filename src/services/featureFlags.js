const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isFeatureEnabled(name, fallback = false) {
  const raw = process.env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return TRUE_VALUES.has(String(raw).trim().toLowerCase());
}

export function getHardeningFlags() {
  return {
    responsesExtractor: isFeatureEnabled('FF_RESPONSES_EXTRACTOR', false),
    policyLayer: isFeatureEnabled('FF_POLICY_LAYER', false),
    postgresJobQueue: isFeatureEnabled('FF_POSTGRES_JOB_QUEUE', false),
    attachmentAnalyzer: isFeatureEnabled('FF_ATTACHMENT_ANALYZER', false),
    semanticShortMemory: isFeatureEnabled('FF_SEMANTIC_SHORT_MEMORY', false),
    asyncAdminMediaForward: isFeatureEnabled('FF_ASYNC_ADMIN_MEDIA_FORWARD', false)
  };
}
