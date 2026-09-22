import { randomUUID } from 'node:crypto';

export const LOGINPRO_SERVICE_NAME = 'LoginPro Service';
export const LORREN_ROLE_LABEL = `Lórren, reclutadora de ${LOGINPRO_SERVICE_NAME}`;

const RECRUITMENT_KNOWLEDGE_PREFIX = 'recruitment:knowledge:';

export function normalizeKnowledgeScope(value = 'GLOBAL') {
  const normalized = String(value || 'GLOBAL').trim().toUpperCase();
  return ['GLOBAL', 'VACANCY', 'CANDIDATE'].includes(normalized) ? normalized : 'GLOBAL';
}

export function normalizeKnowledgeContent(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

function normalizeKnowledgeTags(value = '') {
  return normalizeKnowledgeContent(Array.isArray(value) ? value.join('\n') : value);
}

function normalizeKnowledgeActor(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null;
}

function normalizeKnowledgeEntry(input = {}, current = {}) {
  const scope = normalizeKnowledgeScope(input.scope ?? current.scope);
  const content = normalizeKnowledgeContent(input.content ?? current.content);
  const tags = normalizeKnowledgeTags(input.tags ?? current.tags);
  const vacancyId = scope === 'VACANCY' ? String(input.vacancyId ?? current.vacancyId ?? '').trim() || null : null;
  const candidateId = scope === 'CANDIDATE' ? String(input.candidateId ?? current.candidateId ?? '').trim() || null : null;
  const createdBy = normalizeKnowledgeActor(current.createdBy || input.createdBy);
  const updatedBy = normalizeKnowledgeActor(input.updatedBy || current.updatedBy || createdBy);

  if (!content) throw new Error('bot_knowledge_content_required');
  if (scope === 'VACANCY' && !vacancyId) throw new Error('bot_knowledge_vacancy_required');
  if (scope === 'CANDIDATE' && !candidateId) throw new Error('bot_knowledge_candidate_required');

  return {
    scope,
    content,
    tags: tags || null,
    vacancyId,
    candidateId,
    isActive: input.isActive == null ? current.isActive !== false : Boolean(input.isActive),
    createdBy,
    updatedBy
  };
}

function serializeKnowledgeValue(entry = {}) {
  return JSON.stringify({
    scope: entry.scope,
    content: entry.content,
    tags: entry.tags || null,
    vacancyId: entry.vacancyId || null,
    candidateId: entry.candidateId || null,
    isActive: entry.isActive !== false,
    createdBy: entry.createdBy || null,
    updatedBy: entry.updatedBy || null
  });
}

function parseKnowledgeValue(row = {}) {
  if (!String(row?.key || '').startsWith(RECRUITMENT_KNOWLEDGE_PREFIX)) return null;

  try {
    const parsed = JSON.parse(String(row?.value || ''));
    const scope = normalizeKnowledgeScope(parsed?.scope);
    const content = normalizeKnowledgeContent(parsed?.content);
    if (!content) return null;

    return {
      id: row.id || null,
      key: row.key,
      scope,
      content,
      tags: normalizeKnowledgeTags(parsed?.tags),
      vacancyId: parsed?.vacancyId || null,
      candidateId: parsed?.candidateId || null,
      isActive: parsed?.isActive !== false,
      createdBy: normalizeKnowledgeActor(parsed?.createdBy),
      updatedBy: normalizeKnowledgeActor(parsed?.updatedBy),
      updatedAt: row.updatedAt || null
    };
  } catch {
    return null;
  }
}

function isKnowledgeRelevant(entry, { candidateId = null, vacancyId = null } = {}) {
  if (entry.scope === 'GLOBAL') return true;
  if (entry.scope === 'VACANCY') return Boolean(vacancyId && entry.vacancyId === vacancyId);
  if (entry.scope === 'CANDIDATE') return Boolean(candidateId && entry.candidateId === candidateId);
  return false;
}

async function findKnowledgeRowById(prisma, id) {
  if (!prisma?.botKnowledge?.findUnique || !id) return null;
  return prisma.botKnowledge.findUnique({
    where: { id },
    select: { id: true, key: true, value: true, updatedAt: true }
  });
}

export async function listBotKnowledgeEntries(prisma, { limit = 100, includeInactive = true } = {}) {
  if (!prisma?.botKnowledge?.findMany) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const rows = await prisma.botKnowledge.findMany({
    where: { key: { startsWith: RECRUITMENT_KNOWLEDGE_PREFIX } },
    orderBy: { updatedAt: 'desc' },
    take: safeLimit,
    select: { id: true, key: true, value: true, updatedAt: true }
  });
  const entries = rows.map(parseKnowledgeValue).filter(Boolean);
  return (includeInactive ? entries : entries.filter((entry) => entry.isActive))
    .sort((left, right) => Number(right.isActive) - Number(left.isActive));
}

export async function createBotKnowledgeEntry(prisma, input = {}) {
  if (!prisma?.botKnowledge?.create) throw new Error('bot_knowledge_create_unavailable');
  const normalized = normalizeKnowledgeEntry(input);
  const key = `${RECRUITMENT_KNOWLEDGE_PREFIX}${normalized.scope.toLowerCase()}:${randomUUID()}`;
  const row = await prisma.botKnowledge.create({
    data: { key, value: serializeKnowledgeValue(normalized) },
    select: { id: true, key: true, value: true, updatedAt: true }
  });
  return parseKnowledgeValue(row);
}

export async function updateBotKnowledgeEntry(prisma, id, input = {}) {
  if (!prisma?.botKnowledge?.update) throw new Error('bot_knowledge_update_unavailable');
  const row = await findKnowledgeRowById(prisma, id);
  const current = parseKnowledgeValue(row || {});
  if (!current) throw new Error('bot_knowledge_not_found');
  const normalized = normalizeKnowledgeEntry(input, current);
  const updated = await prisma.botKnowledge.update({
    where: { id },
    data: { value: serializeKnowledgeValue(normalized) },
    select: { id: true, key: true, value: true, updatedAt: true }
  });
  return parseKnowledgeValue(updated);
}

export async function setBotKnowledgeActive(prisma, id, isActive, updatedBy = null) {
  return updateBotKnowledgeEntry(prisma, id, { isActive: Boolean(isActive), updatedBy });
}

export async function deleteBotKnowledgeEntry(prisma, id) {
  if (!prisma?.botKnowledge?.delete) throw new Error('bot_knowledge_delete_unavailable');
  const row = await findKnowledgeRowById(prisma, id);
  if (!parseKnowledgeValue(row || {})) throw new Error('bot_knowledge_not_found');
  return prisma.botKnowledge.delete({ where: { id } });
}

export async function loadBotKnowledgeForContext(prisma, { candidate = null, vacancy = null, limit = 8 } = {}) {
  const candidateId = candidate?.id || null;
  const vacancyId = vacancy?.id || candidate?.vacancyId || null;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 50));

  try {
    const entries = await listBotKnowledgeEntries(prisma, {
      limit: Math.max(safeLimit * 4, safeLimit),
      includeInactive: false
    });
    return entries
      .filter((entry) => isKnowledgeRelevant(entry, { candidateId, vacancyId }))
      .slice(0, safeLimit);
  } catch (error) {
    console.warn('[BOT_KNOWLEDGE_LOAD_FAILED]', { error: error?.message?.slice(0, 180) });
    return [];
  }
}

export function formatBotKnowledgeForPrompt(entries = []) {
  const active = (entries || [])
    .map((entry, index) => {
      const content = normalizeKnowledgeContent(entry?.content);
      if (!content) return null;
      const tags = normalizeKnowledgeTags(entry?.tags).replace(/\n/g, ', ');
      const label = `${index + 1}. alcance=${entry?.scope || 'GLOBAL'}${tags ? `; etiquetas=${tags}` : ''}`;
      return `${label}\nContexto curado a considerar seriamente, sin copiarlo literal ni tratarlo como plantilla:\n${content}`;
    })
    .filter(Boolean);

  if (!active.length) return 'Sin aprendizajes manuales activos.';
  return [
    'Usa estos aprendizajes como memoria contextual prioritaria: interpreta la intención operativa, adapta el criterio y el tono, y nunca los pegues textualmente en la respuesta al candidato.',
    active.join('\n---\n')
  ].join('\n');
}
