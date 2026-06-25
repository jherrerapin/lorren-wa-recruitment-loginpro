import { createMetaAdsClient } from './metaAdsClient.js';

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm',
  'actions', 'date_start', 'date_stop'
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

function safeError(error) {
  return {
    name: error?.name || 'MetaAdsSyncError',
    message: error?.message || 'Error sincronizando Meta Ads',
    code: error?.code || error?.response?.error?.code || null,
    type: error?.type || error?.response?.error?.type || null
  };
}

async function readAllPages(cursor) {
  const rows = [];
  let page = cursor;
  while (page) {
    rows.push(...Array.from(page));
    page = typeof page.hasNext === 'function' && page.hasNext() ? await page.next() : null;
  }
  return rows;
}

async function fetchInsights(adAccount, { since, until, level }) {
  const params = {
    level,
    time_increment: 1,
    time_range: { since, until },
    limit: 100
  };
  return readAllPages(await adAccount.getInsights(INSIGHT_FIELDS, params));
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
        spend: asNumber(row.spend), impressions: Math.round(asNumber(row.impressions)), reach: Math.round(asNumber(row.reach)),
        clicks: Math.round(asNumber(row.clicks)), inlineLinkClicks: Math.round(asNumber(row.inline_link_clicks)),
        ctr: asNumber(row.ctr), cpc: asNumber(row.cpc), cpm: asNumber(row.cpm), rawActions: row.actions || []
      },
      create: {
        date, metaCampaignId: String(row.campaign_id), metaCampaignName: row.campaign_name || null,
        spend: asNumber(row.spend), impressions: Math.round(asNumber(row.impressions)), reach: Math.round(asNumber(row.reach)),
        clicks: Math.round(asNumber(row.clicks)), inlineLinkClicks: Math.round(asNumber(row.inline_link_clicks)),
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
        spend: asNumber(row.spend), impressions: Math.round(asNumber(row.impressions)), reach: Math.round(asNumber(row.reach)),
        clicks: Math.round(asNumber(row.clicks)), inlineLinkClicks: Math.round(asNumber(row.inline_link_clicks)),
        ctr: asNumber(row.ctr), cpc: asNumber(row.cpc), cpm: asNumber(row.cpm), rawActions: row.actions || []
      },
      create: {
        date, metaCampaignId: row.campaign_id || null, metaCampaignName: row.campaign_name || null,
        metaAdsetId: row.adset_id || null, metaAdsetName: row.adset_name || null,
        metaAdId: String(row.ad_id), metaAdName: row.ad_name || null,
        spend: asNumber(row.spend), impressions: Math.round(asNumber(row.impressions)), reach: Math.round(asNumber(row.reach)),
        clicks: Math.round(asNumber(row.clicks)), inlineLinkClicks: Math.round(asNumber(row.inline_link_clicks)),
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
  const today = new Date().toISOString().slice(0, 10);
  const range = { since: since || today, until: until || today };
  console.info('[metaAdsInsightsSync] inicio', { since: range.since, until: range.until, adAccountId: client.adAccountId });
  try {
    const [campaignRows, adRows] = await Promise.all([
      fetchInsights(client.adAccount, { ...range, level: 'campaign' }),
      fetchInsights(client.adAccount, { ...range, level: 'ad' })
    ]);
    const [campaignSnapshots, adSnapshots] = await Promise.all([
      syncCampaignRows(prisma, campaignRows),
      syncAdRows(prisma, adRows)
    ]);
    console.info('[metaAdsInsightsSync] fin', { campaignSnapshots, adSnapshots });
    return { ok: true, enabled: true, campaignSnapshots, adSnapshots };
  } catch (error) {
    const safe = safeError(error);
    console.warn('[metaAdsInsightsSync] error', safe);
    return { ok: false, enabled: true, error: safe };
  }
}

export default { syncMetaAdsInsights };
