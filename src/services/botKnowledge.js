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

export async function loadBotKnowledgeForContext(prisma, { candidate = null, vacancy = null, limit = 8 } = {}) {
  if (!prisma?.botKnowledge?.findMany) return [];

  const candidateId = candidate?.id || null;
  const vacancyId = vacancy?.id || candidate?.vacancyId || null;
  const or = [{ scope: 'GLOBAL' }];
  if (vacancyId) or.push({ scope: 'VACANCY', vacancyId });
  if (candidateId) or.push({ scope: 'CANDIDATE', candidateId });

  try {
    return await prisma.botKnowledge.findMany({
      where: { isActive: true, OR: or },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      select: {
        scope: true,
        content: true,
        tags: true,
        vacancyId: true,
        candidateId: true,
        updatedAt: true
      }
    });
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
      const tags = normalizeKnowledgeContent(entry?.tags).replace(/\n/g, ', ');
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
