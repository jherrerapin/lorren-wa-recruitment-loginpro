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

function parseKnowledgeValue(row = {}) {
  if (!String(row?.key || '').startsWith(RECRUITMENT_KNOWLEDGE_PREFIX)) return null;

  try {
    const parsed = JSON.parse(String(row?.value || ''));
    const scope = normalizeKnowledgeScope(parsed?.scope);
    const content = normalizeKnowledgeContent(parsed?.content);
    if (!content || parsed?.isActive === false) return null;

    return {
      id: row.id || null,
      key: row.key,
      scope,
      content,
      tags: normalizeKnowledgeTags(parsed?.tags),
      vacancyId: parsed?.vacancyId || null,
      candidateId: parsed?.candidateId || null,
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

export async function loadBotKnowledgeForContext(prisma, { candidate = null, vacancy = null, limit = 8 } = {}) {
  if (!prisma?.botKnowledge?.findMany) return [];

  const candidateId = candidate?.id || null;
  const vacancyId = vacancy?.id || candidate?.vacancyId || null;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 50));

  try {
    const rows = await prisma.botKnowledge.findMany({
      where: { key: { startsWith: RECRUITMENT_KNOWLEDGE_PREFIX } },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(safeLimit * 4, safeLimit),
      select: {
        id: true,
        key: true,
        value: true,
        updatedAt: true
      }
    });

    return rows
      .map(parseKnowledgeValue)
      .filter(Boolean)
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
