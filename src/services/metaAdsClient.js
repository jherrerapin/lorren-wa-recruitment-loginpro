import bizSdk from 'facebook-nodejs-business-sdk';

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
  if (!config.enabled) return { ...config, sdk: bizSdk, api: null, adAccount: null };

  const FacebookAdsApi = bizSdk.FacebookAdsApi;
  FacebookAdsApi.setDefaultApiVersion(config.apiVersion);
  const api = FacebookAdsApi.init(config.accessToken);
  const adAccount = new bizSdk.AdAccount(config.adAccountId);
  return { ...config, sdk: bizSdk, api, adAccount };
}

export default { createMetaAdsClient, getMetaAdsConfig };
