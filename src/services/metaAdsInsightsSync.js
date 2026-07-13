import { createMetaAdsClient } from './metaAdsClient.js';

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm',
  'actions', 'date_start', 'date_stop'
];

const CAMPAIGN_FIELDS = ['id', 'name', 'status', 'effective_status'];
const ADSET_FIELDS = ['id', 'name', 'status', 'effective_status', 'campaign_id'];
const AD_FIELDS = [
  'id', 'name', 'status', 'effective_status', 'campaign_id', 'adset_id', 'created_time', 'updated_time'
];

const NON_CURRENT_META_STATUSES = new Set(['ARCHIVED', 'DELETED']);
const MAX_GRAPH_PAGES = 100;

function asDateOnly(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return new Date(`${text}T00:00:00.000Z`);
}

function asDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asInt(value) {
  return Math.round(asNumber(value));
}

function compactUnique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function dateOnlyFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultDateRange() {
  const until = new Date();
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - 90);
  return { since: dateOnlyFromDate(since), until: dateOnlyFromDate(until) };
}

function effectiveStatus(value) {
  return String(value || '').trim().toUpperCase();
}

export function isCurrentMetaEntity(entity) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return false;
  const configuredStatus = effectiveStatus(entity.status);
  const inheritedStatus = effectiveStatus(entity.effective_status);
  return !NON_CURRENT_META_STATUSES.has(configuredStatus)
    && !NON_CURRENT_META_STATUSES.has(inheritedStatus);
}

export function isCurrentMetaAd(ad) {
  return isCurrentMetaEntity(ad);
}

export function filterCurrentMetaAds(ads = []) {
  return (Array.isArray(ads) ? ads : []).filter(isCurrentMetaAd);
}

export function buildCurrentMetaInventory({ campaigns = [], adsets = [], ads = [] } = {}) {
  const currentCampaigns = (Array.isArray(campaigns) ? campaigns : []).filter(isCurrentMetaEntity);
  const currentCampaignIds = new Set(
    currentCampaigns.map((campaign) => String(campaign?.id || '').trim()).filter(Boolean)
  );

  const currentAdsets = (Array.isArray(adsets) ? adsets : [])
    .filter(isCurrentMetaEntity)
    .filter((adset) => currentCampaignIds.has(String(adset?.campaign_id || '').trim()));
  const currentAdsetIds = new Set(
    currentAdsets.map((adset) => String(adset?.id || '').trim()).filter(Boolean)
  );

  const currentAds = filterCurrentMetaAds(ads).filter((ad) => {
    const campaignId = String(ad?.campaign_id || '').trim();
    const adsetId = String(ad?.adset_id || '').trim();
    return currentCampaignIds.has(campaignId) && currentAdsetIds.has(adsetId);
  });

  return { currentCampaigns, currentAdsets, currentAds };
}

function isMetaActive(status, fallbackStatus) {
  return effectiveStatus(status || fallbackStatus) === 'ACTIVE';
}

function safeError(error) {
  const meta = error?.response?.data?.error || error?.metaError || null;
  return {
    name: error?.name || 'MetaAdsSyncError',
    message: meta?.message || error?.message || 'Error sincronizando Meta Ads',
    code: error?.code || meta?.code || null,
    type: meta?.type || null,
    fbtraceId: meta?.fbtrace_id || null,
    missing: error?.missing || null
  };
}

function failureResult({ stage, error, range, enabled = true }) {
  return {
    ok: false,
    partial: false,
    enabled,
    stage,
    since: range?.since || null,
    until: range?.until || null,
    error: safeError(error)
  };
}

async function readAllPages(client, path, params = {}) {
  const rows = [];
  const visited = new Set();
  let payload = await client.graphGet(path, params);
  let page = 0;

  while (payload) {
    rows.push(...(Array.isArray(payload.data) ? payload.data : []));
    const nextUrl = payload?.paging?.next || null;
    if (!nextUrl) break;
    if (visited.has(nextUrl)) {
      const error = new Error('Meta devolvió una paginación repetida.');
      error.code = 'META_ADS_PAGINATION_LOOP';
      throw error;
    }
    visited.add(nextUrl);
    page += 1;
    if (page >= MAX_GRAPH_PAGES) {
      const error = new Error('La paginación de Meta superó el límite de seguridad.');
      error.code = 'META_ADS_PAGINATION_LIMIT';
      throw error;
    }
    payload = await client.graphGetUrl(nextUrl);
  }

  return rows;
}

async function fetchCampaignInventory(client) {
  return readAllPages(client, `${client.adAccountId}/campaigns`, {
    fields: CAMPAIGN_FIELDS.join(','),
    limit: 100
  });
}

async function fetchAdsetInventory(client) {
  return readAllPages(client, `${client.adAccountId}/adsets`, {
    fields: ADSET_FIELDS.join(','),
    limit: 100
  });
}

async function fetchAdInventory(client) {
  return readAllPages(client, `${client.adAccountId}/ads`, {
    fields: AD_FIELDS.join(','),
    limit: 100
  });
}

async function fetchInsights(client, { since, until, level }) {
  return readAllPages(client, `${client.adAccountId}/insights`, {
    fields: INSIGHT_FIELDS.join(','),
    level,
    time_increment: 1,
    time_range: JSON.stringify({ since, until }),
    limit: 100
  });
}

async function fetchAdAccount(client) {
  return client.graphGet(client.adAccountId, {
    fields: ['id', 'name', 'currency', 'timezone_name'].join(',')
  });
}

async function persistAdAccount(prisma, client, account = {}) {
  await prisma.metaAdAccount.upsert({
    where: { accountId: String(account.id || client.adAccountId).replace(/^act_/, '') },
    update: {
      name: account.name || null,
      currency: account.currency || null,
      timezoneName: account.timezone_name || null,
      isActive: true
    },
    create: {
      accountId: String(account.id || client.adAccountId).replace(/^act_/, ''),
      name: account.name || null,
      currency: account.currency || null,
      timezoneName: account.timezone_name || null,
      isActive: true
    }
  });
}

async function removeGeneratedCampaignLevelRows(prisma, campaigns = []) {
  const campaignIds = compactUnique(
    (Array.isArray(campaigns) ? campaigns : [])
      .map((campaign) => String(campaign?.id || '').trim())
  );
  if (!campaignIds.length) return 0;
  const result = await prisma.campaign.deleteMany({
    where: {
      code: { in: campaignIds },
      createdByUsername: 'meta-ads-sync',
      candidates: { none: {} }
    }
  });
  return result.count || 0;
}

export async function markAdsMissingFromMeta(prisma, ads = [], syncedAt = new Date()) {
  const currentAdIds = compactUnique(
    (Array.isArray(ads) ? ads : [])
      .map((ad) => String(ad?.id || '').trim())
  );
  const where = {
    sourceType: 'META_ADS',
    endsAt: null
  };
  if (currentAdIds.length) where.code = { notIn: currentAdIds };

  const result = await prisma.campaign.updateMany({
    where,
    data: {
      isActive: false,
      endsAt: syncedAt
    }
  });
  return result.count || 0;
}

function adInventoryNotes(ad = {}, campaignName = '', adsetName = '') {
  const safeAd = ad && typeof ad === 'object' && !Array.isArray(ad) ? ad : {};
  const metaState = effectiveStatus(safeAd.effective_status || safeAd.status) || 'UNKNOWN';
  return `Anuncio sincronizado desde Meta Ads. Campaña: ${campaignName || safeAd.campaign_id || '—'}. Conjunto: ${adsetName || safeAd.adset_id || '—'}. campaign_id: ${safeAd.campaign_id || '—'}. adset_id: ${safeAd.adset_id || '—'}. estado_meta: ${metaState}.`;
}

async function upsertAdsAsDashboardRows(prisma, ads = [], campaigns = [], adsets = [], syncedAt = new Date()) {
  const rows = [];
  const safeCampaigns = Array.isArray(campaigns) ? campaigns : [];
  const safeAdsets = Array.isArray(adsets) ? adsets : [];
  const safeAds = Array.isArray(ads) ? ads : [];
  const campaignNames = new Map(
    safeCampaigns.map((campaign) => [String(campaign?.id || ''), campaign?.name || null])
  );
  const adsetNames = new Map(
    safeAdsets.map((adset) => [String(adset?.id || ''), adset?.name || null])
  );

  for (const ad of safeAds) {
    if (!ad || typeof ad !== 'object' || Array.isArray(ad)) continue;
    const code = String(ad.id || '').trim();
    if (!code) continue;
    const campaignId = String(ad.campaign_id || '').trim();
    const adsetId = String(ad.adset_id || '').trim();
    const row = await prisma.campaign.upsert({
      where: { code },
      update: {
        name: ad.name || `Meta Ad ${code}`,
        sourceType: 'META_ADS',
        isActive: isMetaActive(ad.effective_status, ad.status),
        startsAt: asDateTime(ad.created_time),
        endsAt: null,
        notes: adInventoryNotes(ad, campaignNames.get(campaignId), adsetNames.get(adsetId)),
        createdByUsername: 'meta-ads-sync',
        updatedAt: syncedAt
      },
      create: {
        code,
        name: ad.name || `Meta Ad ${code}`,
        sourceType: 'META_ADS',
        isActive: isMetaActive(ad.effective_status, ad.status),
        startsAt: asDateTime(ad.created_time),
        endsAt: null,
        notes: adInventoryNotes(ad, campaignNames.get(campaignId), adsetNames.get(adsetId)),
        createdByUsername: 'meta-ads-sync',
        updatedAt: syncedAt
      }
    });
    rows.push(row);
  }

  return { count: rows.length, rows };
}

export async function associateCandidatesByExactAdId(prisma, campaignRows = []) {
  const safeRows = Array.isArray(campaignRows) ? campaignRows : [];
  const results = await Promise.all(safeRows.map(async (campaign) => {
    if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)) {
      return { associated: 0, vacancyFilled: 0 };
    }
    const metaAdId = String(campaign.code || '').trim();
    if (!metaAdId) return { associated: 0, vacancyFilled: 0 };

    const campaignResult = await prisma.candidate.updateMany({
      where: { sourceType: 'META_ADS', metaAdId, campaignId: null },
      data: { campaignId: campaign.id }
    });

    let vacancyFilled = 0;
    if (campaign.vacancyId) {
      const vacancyResult = await prisma.candidate.updateMany({
        where: { sourceType: 'META_ADS', metaAdId, vacancyId: null },
        data: { vacancyId: campaign.vacancyId }
      });
      vacancyFilled = vacancyResult.count || 0;
    }

    return { associated: campaignResult.count || 0, vacancyFilled };
  }));

  return results.reduce((total, result) => ({
    associated: total.associated + result.associated,
    vacancyFilled: total.vacancyFilled + result.vacancyFilled
  }), { associated: 0, vacancyFilled: 0 });
}

async function syncCampaignRows(prisma, rows = []) {
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const date = asDateOnly(row.date_start);
    if (!date || !row.campaign_id) continue;
    await prisma.metaCampaignSnapshot.upsert({
      where: { date_metaCampaignId: { date, metaCampaignId: String(row.campaign_id) } },
      update: {
        metaCampaignName: row.campaign_name || null,
        spend: asNumber(row.spend), impressions: asInt(row.impressions), reach: asInt(row.reach),
        clicks: asInt(row.clicks), inlineLinkClicks: asInt(row.inline_link_clicks),
        ctr: asNumber(row.ctr), cpc: asNumber(row.cpc), cpm: asNumber(row.cpm), rawActions: row.actions || []
      },
      create: {
        date, metaCampaignId: String(row.campaign_id), metaCampaignName: row.campaign_name || null,
        spend: asNumber(row.spend), impressions: asInt(row.impressions), reach: asInt(row.reach),
        clicks: asInt(row.clicks), inlineLinkClicks: asInt(row.inline_link_clicks),
        ctr: asNumber(row.ctr), cpc: asNumber(row.cpc), cpm: asNumber(row.cpm), rawActions: row.actions || []
      }
    });
    count += 1;
  }
  return count;
}

async function syncAdRows(prisma, rows = []) {
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const date = asDateOnly(row.date_start);
    if (!date || !row.ad_id) continue;
    await prisma.metaAdSnapshot.upsert({
      where: { date_metaAdId: { date, metaAdId: String(row.ad_id) } },
      update: {
        metaCampaignId: row.campaign_id || null, metaCampaignName: row.campaign_name || null,
        metaAdsetId: row.adset_id || null, metaAdsetName: row.adset_name || null, metaAdName: row.ad_name || null,
        spend: asNumber(row.spend), impressions: asInt(row.impressions), reach: asInt(row.reach),
        clicks: asInt(row.clicks), inlineLinkClicks: asInt(row.inline_link_clicks),
        ctr: asNumber(row.ctr), cpc: asNumber(row.cpc), cpm: asNumber(row.cpm), rawActions: row.actions || []
      },
      create: {
        date, metaCampaignId: row.campaign_id || null, metaCampaignName: row.campaign_name || null,
        metaAdsetId: row.adset_id || null, metaAdsetName: row.adset_name || null,
        metaAdId: String(row.ad_id), metaAdName: row.ad_name || null,
        spend: asNumber(row.spend), impressions: asInt(row.impressions), reach: asInt(row.reach),
        clicks: asInt(row.clicks), inlineLinkClicks: asInt(row.inline_link_clicks),
        ctr: asNumber(row.ctr), cpc: asNumber(row.cpc), cpm: asNumber(row.cpm), rawActions: row.actions || []
      }
    });
    count += 1;
  }
  return count;
}

export async function syncMetaAdsInsights(prisma, { since, until } = {}, dependencies = {}) {
  const client = dependencies.client || createMetaAdsClient();
  const fallbackRange = defaultDateRange();
  const range = { since: since || fallbackRange.since, until: until || fallbackRange.until };

  if (!client.enabled) {
    const error = new Error('Meta Ads no está configurado.');
    error.name = 'MetaAdsNotConfigured';
    error.code = 'META_ADS_NOT_CONFIGURED';
    error.missing = client.missing;
    return failureResult({ stage: 'configuration', error, range, enabled: false });
  }

  console.info('[metaAdsInsightsSync] inicio', {
    since: range.since,
    until: range.until,
    adAccountId: client.adAccountId
  });

  let account;
  let rawCampaigns;
  let rawAdsets;
  let rawAds;
  try {
    [account, rawCampaigns, rawAdsets, rawAds] = await Promise.all([
      fetchAdAccount(client),
      fetchCampaignInventory(client),
      fetchAdsetInventory(client),
      fetchAdInventory(client)
    ]);
  } catch (error) {
    const failure = failureResult({ stage: 'inventory_fetch', error, range });
    console.warn('[metaAdsInsightsSync] inventario no disponible', failure.error);
    return failure;
  }

  const inventory = buildCurrentMetaInventory({
    campaigns: rawCampaigns,
    adsets: rawAdsets,
    ads: rawAds
  });
  const syncedAt = new Date();

  let removedCampaignRows;
  let missingAds;
  let dashboardInventory;
  let exactAssociations;
  try {
    await persistAdAccount(prisma, client, account);
    removedCampaignRows = await removeGeneratedCampaignLevelRows(prisma, rawCampaigns);
    missingAds = await markAdsMissingFromMeta(prisma, inventory.currentAds, syncedAt);
    dashboardInventory = await upsertAdsAsDashboardRows(
      prisma,
      inventory.currentAds,
      inventory.currentCampaigns,
      inventory.currentAdsets,
      syncedAt
    );
    exactAssociations = await associateCandidatesByExactAdId(prisma, dashboardInventory.rows);
  } catch (error) {
    const failure = failureResult({ stage: 'inventory_persistence', error, range });
    console.warn('[metaAdsInsightsSync] inventario no persistido', failure.error);
    return failure;
  }

  let campaignSnapshots = 0;
  let adSnapshots = 0;
  let insights = { ok: true, error: null };
  try {
    const [campaignRows, adRows] = await Promise.all([
      fetchInsights(client, { ...range, level: 'campaign' }),
      fetchInsights(client, { ...range, level: 'ad' })
    ]);
    [campaignSnapshots, adSnapshots] = await Promise.all([
      syncCampaignRows(prisma, campaignRows),
      syncAdRows(prisma, adRows)
    ]);
  } catch (error) {
    insights = { ok: false, error: safeError(error) };
    console.warn('[metaAdsInsightsSync] métricas no disponibles; inventario conservado', insights.error);
  }

  const result = {
    ok: true,
    partial: !insights.ok,
    enabled: true,
    stage: insights.ok ? 'complete' : 'inventory_complete',
    since: range.since,
    until: range.until,
    syncedAt,
    removedCampaignRows,
    rawInventoryCampaigns: rawCampaigns.length,
    currentCampaigns: inventory.currentCampaigns.length,
    rawInventoryAdsets: rawAdsets.length,
    currentAdsets: inventory.currentAdsets.length,
    rawInventoryAds: rawAds.length,
    currentAds: dashboardInventory.count,
    ignoredNonCurrentAds: rawAds.length - inventory.currentAds.length,
    missingAds,
    exactAssociations,
    campaignSnapshots,
    adSnapshots,
    insights
  };

  console.info('[metaAdsInsightsSync] fin', {
    ok: result.ok,
    partial: result.partial,
    currentCampaigns: result.currentCampaigns,
    currentAdsets: result.currentAdsets,
    currentAds: result.currentAds,
    missingAds: result.missingAds,
    insightsOk: result.insights.ok
  });
  return result;
}

export default { syncMetaAdsInsights };
