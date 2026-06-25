const DEFAULT_META_API_VERSION = 'v23.0';

function normalizeAdAccountId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

export function getMetaAdsConfig(env = process.env) {
  const accessToken = env.META_ADS_ACCESS_TOKEN || env.META_ACCESS_TOKEN || null;
  const adAccountId = normalizeAdAccountId(env.META_AD_ACCOUNT_ID);
  const apiVersion = String(env.META_API_VERSION || DEFAULT_META_API_VERSION).trim();
  const missing = [];
  if (!accessToken) missing.push('META_ADS_ACCESS_TOKEN or META_ACCESS_TOKEN');
  if (!adAccountId) missing.push('META_AD_ACCOUNT_ID');
  return { enabled: missing.length === 0, accessToken, adAccountId, apiVersion, missing };
}

export function createMetaAdsClient(env = process.env) {
  const config = getMetaAdsConfig(env);
  const sdkMissing = 'facebook-nodejs-business-sdk not installed; run npm install facebook-nodejs-business-sdk and commit package-lock.json';

  return {
    ...config,
    enabled: false,
    missing: [...config.missing, sdkMissing],
    sdk: null,
    api: null,
    adAccount: null
  };
}

export default { createMetaAdsClient, getMetaAdsConfig };
