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

function asInt(value) {
  return Math.round(asNumber(value));
}

function compactUnique(values = []) {
  return [...new Set(values.filter(Boolean))];
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

async function upsertInternalCampaignsFromMeta(prisma, rows = []) {
  let count = 0;
  const campaigns = compactUnique(rows.map((row) => row.campaign_id))
    .map((campaignId) => rows.find((row) => row.campaign_id === campaignId))
    .filter(Boolean);

  for (const row of campaigns) {
    const code = String(row.campaign_id || '').trim();
    if (!code) continue;
    await prisma.campaign.upsert({
      where: { code },
      update: {
        name: row.campaign_name || `Meta Ads ${code}`,
        sourceType: 'META_ADS',
        isActive: true,
        notes: 'Sincronizada automáticamente desde Meta Ads.'
      },
      create: {
        code,
        name: row.campaign_name || `Meta Ads ${code}`,
        sourceType: 'META_ADS',
        isActive: true,
        notes: 'Sincronizada automáticamente desde Meta Ads.',
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
  const today = new Date().toISOString().slice(0, 10);
  const range = { since: since || today, until: until || today };
  console.info('[metaAdsInsightsSync] inicio', { since: range.since, until: range.until, adAccountId: client.adAccountId });
  try {
    await syncAdAccount(prisma, client);
    const [campaignRows, adRows] = await Promise.all([
      fetchInsights(client, { ...range, level: 'campaign' }),
      fetchInsights(client, { ...range, level: 'ad' })
    ]);
    const [autoCampaigns, campaignSnapshots, adSnapshots] = await Promise.all([
      upsertInternalCampaignsFromMeta(prisma, campaignRows),
      syncCampaignRows(prisma, campaignRows),
      syncAdRows(prisma, adRows)
    ]);
    console.info('[metaAdsInsightsSync] fin', { autoCampaigns, campaignSnapshots, adSnapshots });
    return { ok: true, enabled: true, autoCampaigns, campaignSnapshots, adSnapshots };
  } catch (error) {
    const safe = safeError(error);
    console.warn('[metaAdsInsightsSync] error', safe);
    return { ok: false, enabled: true, error: safe };
  }
}

export default { syncMetaAdsInsights };
