import { createMetaAdsClient } from './metaAdsClient.js';

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm',
  'actions', 'date_start', 'date_stop'
];

const CAMPAIGN_FIELDS = [
  'id', 'name', 'status', 'effective_status', 'objective', 'start_time', 'stop_time'
];

const AD_FIELDS = [
  'id', 'name', 'status', 'effective_status', 'campaign_id', 'adset_id', 'created_time', 'updated_time'
];

function asDateOnly(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return new Date(`${text}T00:00:00.000Z`);
}

function asNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asInt(value) {
  return Math.round(asNumber(value));
}

function compactUnique(values = []) {
  return [...new Set(values.filter(Boolean))];
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

async function readAllPages(client, path, params = {}) {
  const rows = [];
  let payload = await client.graphGet(path, params);

  while (payload) {
    rows.push(...(Array.isArray(payload.data) ? payload.data : []));
    payload = payload?.paging?.next ? await client.graphGetUrl(payload.paging.next) : null;
  }

  return rows;
}

async function fetchCampaignInventory(client) {
  return readAllPages(client, `${client.adAccountId}/campaigns`, {
    fields: CAMPAIGN_FIELDS.join(','),
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

async function syncAdAccount(prisma, client) {
  const account = await client.graphGet(client.adAccountId, {
    fields: ['id', 'name', 'currency', 'timezone_name'].join(',')
  });

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
  const campaignIds = compactUnique(campaigns.map((campaign) => String(campaign.id || '').trim())).filter(Boolean);
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

async function upsertAdsAsDashboardRows(prisma, ads = [], campaigns = []) {
  let count = 0;
  const campaignNames = new Map(campaigns.map((campaign) => [String(campaign.id || ''), campaign.name || null]));

  for (const ad of ads) {
    const code = String(ad.id || '').trim();
    if (!code) continue;
    const campaignId = String(ad.campaign_id || '').trim();
    const campaignName = campaignNames.get(campaignId) || campaignId || 'Sin campaña Meta';
    const metaState = effectiveStatus(ad.effective_status || ad.status) || 'UNKNOWN';
    await prisma.campaign.upsert({
      where: { code },
      update: {
        name: ad.name || `Meta Ad ${code}`,
        sourceType: 'META_ADS',
        isActive: isMetaActive(ad.effective_status, ad.status),
        notes: `Anuncio sincronizado desde Meta Ads. Campaña: ${campaignName}. campaign_id: ${campaignId || '—'}. adset_id: ${ad.adset_id || '—'}. estado_meta: ${metaState}.`
      },
      create: {
        code,
        name: ad.name || `Meta Ad ${code}`,
        sourceType: 'META_ADS',
        isActive: isMetaActive(ad.effective_status, ad.status),
        notes: `Anuncio sincronizado desde Meta Ads. Campaña: ${campaignName}. campaign_id: ${campaignId || '—'}. adset_id: ${ad.adset_id || '—'}. estado_meta: ${metaState}.`,
        createdByUsername: 'meta-ads-sync'
      }
    });
    count += 1;
  }

  return count;
}

async function upsertInternalCampaignsFromMeta(prisma, rows = []) {
  let count = 0;
  const ads = compactUnique(rows.map((row) => row.ad_id))
    .map((adId) => rows.find((row) => row.ad_id === adId))
    .filter(Boolean);

  for (const row of ads) {
    const code = String(row.ad_id || '').trim();
    if (!code) continue;
    await prisma.campaign.upsert({
      where: { code },
      update: {
        name: row.ad_name || `Meta Ad ${code}`,
        sourceType: 'META_ADS',
        isActive: true,
        notes: `Anuncio con métricas sincronizadas desde Meta Ads. Campaña: ${row.campaign_name || row.campaign_id || '—'}. campaign_id: ${row.campaign_id || '—'}. adset_id: ${row.adset_id || '—'}.`
      },
      create: {
        code,
        name: row.ad_name || `Meta Ad ${code}`,
        sourceType: 'META_ADS',
        isActive: true,
        notes: `Anuncio con métricas sincronizadas desde Meta Ads. Campaña: ${row.campaign_name || row.campaign_id || '—'}. campaign_id: ${row.campaign_id || '—'}. adset_id: ${row.adset_id || '—'}.`,
        createdByUsername: 'meta-ads-sync'
      }
    });
    count += 1;
  }

  return count;
}

async function syncCampaignRows(prisma, rows = []) {
  let count = 0;
  for (const row of rows) {
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
  for (const row of rows) {
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

export async function syncMetaAdsInsights(prisma, { since, until } = {}) {
  const client = createMetaAdsClient();
  if (!client.enabled) return { ok: true, enabled: false, message: 'Meta Ads no configurado. Las métricas internas de Lórren siguen disponibles.', missing: client.missing };
  const fallbackRange = defaultDateRange();
  const range = { since: since || fallbackRange.since, until: until || fallbackRange.until };
  console.info('[metaAdsInsightsSync] inicio', { since: range.since, until: range.until, adAccountId: client.adAccountId });
  try {
    await syncAdAccount(prisma, client);
    const [campaignInventory, adInventory, campaignRows, adRows] = await Promise.all([
      fetchCampaignInventory(client),
      fetchAdInventory(client),
      fetchInsights(client, { ...range, level: 'campaign' }),
      fetchInsights(client, { ...range, level: 'ad' })
    ]);
    const [removedCampaignRows, inventoryAds, autoAds, campaignSnapshots, adSnapshots] = await Promise.all([
      removeGeneratedCampaignLevelRows(prisma, campaignInventory),
      upsertAdsAsDashboardRows(prisma, adInventory, campaignInventory),
      upsertInternalCampaignsFromMeta(prisma, adRows),
      syncCampaignRows(prisma, campaignRows),
      syncAdRows(prisma, adRows)
    ]);
    console.info('[metaAdsInsightsSync] fin', { removedCampaignRows, inventoryCampaigns: campaignInventory.length, inventoryAds, autoAds, campaignSnapshots, adSnapshots });
    return { ok: true, enabled: true, since: range.since, until: range.until, removedCampaignRows, inventoryCampaigns: campaignInventory.length, inventoryAds, autoAds, campaignSnapshots, adSnapshots };
  } catch (error) {
    const safe = safeError(error);
    console.warn('[metaAdsInsightsSync] error', safe);
    return { ok: false, enabled: true, since: range.since, until: range.until, error: safe };
  }
}

export default { syncMetaAdsInsights };
