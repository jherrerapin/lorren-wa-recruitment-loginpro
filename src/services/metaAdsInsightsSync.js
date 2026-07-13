import { createMetaAdsClient } from './metaAdsClient.js';

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm',
  'actions', 'date_start', 'date_stop'
];

// Meta expone campaign y adset como relaciones del objeto Ad. Consultarlas en
// una sola fuente evita que un fallo secundario en /campaigns o /adsets impida
// reconocer correctamente que una cuenta no tiene anuncios actuales.
const AD_INVENTORY_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'campaign_id',
  'adset_id',
  'created_time',
  'updated_time',
  'campaign{id,name,status,effective_status}',
  'adset{id,name,status,effective_status,campaign_id}'
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

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeRelatedEntity(value, fallbackId, extra = {}) {
  const entity = safeObject(value);
  const id = String(entity?.id || fallbackId || '').trim();
  if (!id) return null;
  return { ...extra, ...(entity || {}), id };
}

export function isCurrentMetaEntity(entity) {
  if (!safeObject(entity)) return false;
  const configuredStatus = effectiveStatus(entity.status);
  const inheritedStatus = effectiveStatus(entity.effective_status);

  // La ausencia total de estado no demuestra que la entidad exista actualmente.
  // Si Meta omite la expansión de campaign/adset, el inventario falla cerrado
  // para no mantener visibles anuncios huérfanos o históricos.
  if (!configuredStatus && !inheritedStatus) return false;

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
  const campaignById = new Map();
  const adsetById = new Map();

  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    const normalized = normalizeRelatedEntity(campaign, campaign?.id);
    if (normalized) campaignById.set(normalized.id, normalized);
  }
  for (const adset of Array.isArray(adsets) ? adsets : []) {
    const normalized = normalizeRelatedEntity(adset, adset?.id);
    if (normalized) adsetById.set(normalized.id, normalized);
  }

  const currentAds = [];
  const currentCampaignById = new Map();
  const currentAdsetById = new Map();

  for (const rawAd of Array.isArray(ads) ? ads : []) {
    const ad = safeObject(rawAd);
    if (!ad || !isCurrentMetaAd(ad)) continue;

    const campaignId = String(ad.campaign_id || ad.campaign?.id || '').trim();
    const adsetId = String(ad.adset_id || ad.adset?.id || '').trim();
    if (!campaignId || !adsetId) continue;

    const campaign = normalizeRelatedEntity(
      ad.campaign || campaignById.get(campaignId),
      campaignId
    );
    const adset = normalizeRelatedEntity(
      ad.adset || adsetById.get(adsetId),
      adsetId,
      { campaign_id: campaignId }
    );

    if (!campaign || !adset) continue;
    if (!isCurrentMetaEntity(campaign) || !isCurrentMetaEntity(adset)) continue;
    if (String(adset.campaign_id || campaignId).trim() !== campaignId) continue;

    currentCampaignById.set(campaignId, campaign);
    currentAdsetById.set(adsetId, adset);
    currentAds.push({ ...ad, campaign_id: campaignId, adset_id: adsetId });
  }

  return {
    currentCampaigns: [...currentCampaignById.values()],
    currentAdsets: [...currentAdsetById.values()],
    currentAds
  };
}

function isMetaActive(status, fallbackStatus) {
  return effectiveStatus(status || fallbackStatus) === 'ACTIVE';
}

function sanitizeErrorMessage(value) {
  return String(value || 'Error sincronizando Meta Ads')
    .replace(/([?&])access_token=[^&\s]+/gi, '$1access_token=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function safeError(error) {
  const meta = error?.response?.data?.error || error?.metaError || null;
  const metaCode = error?.metaCode ?? meta?.code ?? null;
  const metaSubcode = error?.metaSubcode ?? meta?.error_subcode ?? null;
  return {
    name: error?.name || 'MetaAdsSyncError',
    message: sanitizeErrorMessage(meta?.message || error?.message),
    code: metaCode ?? error?.code ?? null,
    subcode: metaSubcode,
    type: error?.type || meta?.type || null,
    fbtraceId: error?.fbtraceId || meta?.fbtrace_id || null,
    httpStatus: error?.httpStatus || error?.response?.status || null,
    endpoint: error?.endpoint || null,
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

async function fetchAdInventory(client) {
  return readAllPages(client, `${client.adAccountId}/ads`, {
    fields: AD_INVENTORY_FIELDS.join(','),
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

export async function markAdsMissingFromMeta(prisma, ads = [], syncedAt = new Date()) {
  const currentAdIds = [...new Set(
    (Array.isArray(ads) ? ads : [])
      .map((ad) => String(ad?.id || '').trim())
      .filter(Boolean)
  )];
  const where = { sourceType: 'META_ADS', endsAt: null };
  if (currentAdIds.length) where.code = { notIn: currentAdIds };

  const result = await prisma.campaign.updateMany({
    where,
    data: { isActive: false, endsAt: syncedAt }
  });
  return result.count || 0;
}

function adInventoryNotes(ad = {}, campaignName = '', adsetName = '') {
  const safeAd = safeObject(ad) || {};
  const metaState = effectiveStatus(safeAd.effective_status || safeAd.status) || 'UNKNOWN';
  return `Anuncio sincronizado desde Meta Ads. Campaña: ${campaignName || safeAd.campaign_id || '—'}. Conjunto: ${adsetName || safeAd.adset_id || '—'}. campaign_id: ${safeAd.campaign_id || '—'}. adset_id: ${safeAd.adset_id || '—'}. estado_meta: ${metaState}.`;
}

async function upsertAdsAsDashboardRows(prisma, inventory, syncedAt = new Date()) {
  const rows = [];
  const campaigns = Array.isArray(inventory?.currentCampaigns) ? inventory.currentCampaigns : [];
  const adsets = Array.isArray(inventory?.currentAdsets) ? inventory.currentAdsets : [];
  const ads = Array.isArray(inventory?.currentAds) ? inventory.currentAds : [];
  const campaignNames = new Map(campaigns.map((row) => [String(row.id), row.name || null]));
  const adsetNames = new Map(adsets.map((row) => [String(row.id), row.name || null]));

  for (const ad of ads) {
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
    if (!safeObject(campaign)) return { associated: 0, vacancyFilled: 0 };
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
    if (!safeObject(row)) continue;
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
    if (!safeObject(row)) continue;
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
    const error = new Error('Meta Ads no está configurado con una credencial de Marketing API.');
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
  try {
    account = await fetchAdAccount(client);
  } catch (error) {
    const failure = failureResult({ stage: 'account_fetch', error, range });
    console.warn('[metaAdsInsightsSync] cuenta no disponible', failure.error);
    return failure;
  }

  let rawAds;
  try {
    rawAds = await fetchAdInventory(client);
  } catch (error) {
    const failure = failureResult({ stage: 'ads_fetch', error, range });
    console.warn('[metaAdsInsightsSync] anuncios no disponibles', failure.error);
    return failure;
  }

  const inventory = buildCurrentMetaInventory({ ads: rawAds });
  const syncedAt = new Date();

  let dashboardInventory;
  let missingAds;
  let exactAssociations;
  try {
    await persistAdAccount(prisma, client, account);
    dashboardInventory = await upsertAdsAsDashboardRows(prisma, inventory, syncedAt);
    missingAds = await markAdsMissingFromMeta(prisma, inventory.currentAds, syncedAt);
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
    rawInventoryAds: rawAds.length,
    currentCampaigns: inventory.currentCampaigns.length,
    currentAdsets: inventory.currentAdsets.length,
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
