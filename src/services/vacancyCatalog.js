const DEFAULT_NEUTRAL_VACANCY_PROMPT = 'Para orientarte mejor, ¿sobre cuál oferta nos escribes? Puedes decirme el cargo o la ciudad del anuncio.';

export const DEFAULT_VACANCY_SEED = Object.freeze([
  {
    key: 'auxiliar_cargue_descargue_ibague',
    title: 'Auxiliar de Cargue y Descargue',
    city: 'Ibagué',
    description: 'Apoyo operativo en cargue y descargue para operación logística.',
    profile: 'Persona con buena condición física y disponibilidad de turnos.',
    botIntroText: 'Estamos buscando personal para operación logística en Ibagué.',
    requirementsSummary: 'Pago quincenal, turnos rotativos, contrato obra labor y medio de transporte.',
    adTextHints: 'anuncio auxiliar logistico ibague cargue descargue aeropuerto operacion turnos',
    aliases: ['auxiliar', 'cargue', 'descargue', 'aeropuerto', 'operario logistico'],
    isActive: true,
    displayOrder: 1
  },
  {
    key: 'coordinador_ibague',
    title: 'Coordinador',
    city: 'Ibagué',
    description: 'Coordinación operativa y seguimiento de equipo en campo.',
    profile: 'Perfil de liderazgo, orden y experiencia coordinando personal.',
    botIntroText: 'Tenemos una oferta para coordinar operación en Ibagué.',
    requirementsSummary: 'Experiencia liderando equipos, seguimiento operativo y reportes básicos.',
    adTextHints: 'anuncio coordinador ibague liderazgo operacion supervisor equipo',
    aliases: ['coordinador', 'coordinadora', 'lider', 'coordinación', 'supervisor'],
    isActive: true,
    displayOrder: 2
  }
]);

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toAliasList(aliases) {
  if (Array.isArray(aliases)) return aliases.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof aliases === 'string') {
    const trimmed = aliases.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch {
      return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

export function getActiveVacancyCatalog(vacancies = []) {
  return (vacancies || [])
    .filter((vacancy) => Boolean(vacancy?.isActive))
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
    .map((vacancy) => ({
      ...vacancy,
      aliases: toAliasList(vacancy.aliases)
    }));
}

function scoreVacancy(text, vacancy) {
  const nText = normalizeText(text);
  if (!nText) return { score: 0, sources: [] };

  const scoreParts = [];
  const nTitle = normalizeText(vacancy.title);
  const nCity = normalizeText(vacancy.city);
  const keyParts = String(vacancy.key || '').split('_').filter((part) => part.length > 2).map((part) => normalizeText(part));
  const aliasParts = (vacancy.aliases || []).map((alias) => normalizeText(alias));
  const adHintParts = normalizeText(vacancy.adTextHints || '')
    .split(/[\s,.;:\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 2);

  if (nTitle && nText.includes(nTitle)) scoreParts.push({ score: 4, source: 'title' });
  if (nCity && nText.includes(nCity)) scoreParts.push({ score: 2, source: 'city' });

  for (const keyPart of keyParts) {
    if (keyPart && nText.includes(keyPart)) scoreParts.push({ score: 1, source: 'key' });
  }

  for (const alias of aliasParts) {
    if (alias && nText.includes(alias)) scoreParts.push({ score: 2, source: 'alias' });
  }

  for (const hint of adHintParts) {
    if (hint && nText.includes(hint)) scoreParts.push({ score: 1.5, source: 'ad_text_hints' });
  }

  const score = scoreParts.reduce((total, item) => total + item.score, 0);
  const sources = [...new Set(scoreParts.map((item) => item.source))];
  return { score, sources };
}

function detectCity(text, activeVacancies) {
  const nText = normalizeText(text);
  const cityScores = new Map();

  for (const vacancy of activeVacancies) {
    const city = normalizeText(vacancy.city);
    if (!city) continue;
    if (!cityScores.has(city)) {
      cityScores.set(city, { cityKey: city, score: 0, source: 'vacancy_catalog' });
    }
    if (nText.includes(city)) {
      cityScores.get(city).score += 1;
      cityScores.get(city).source = 'text';
    }
  }

  const ordered = [...cityScores.values()].sort((a, b) => b.score - a.score);
  const best = ordered[0] || { cityKey: null, score: 0, source: 'none' };
  const confidence = best.score >= 1 ? 0.9 : 0;
  return {
    cityKey: best.cityKey,
    confidence,
    source: confidence > 0 ? best.source : 'none'
  };
}

export function detectVacancyAndCity({ text = '', activeVacancies = [], currentVacancyKey = null } = {}) {
  const catalog = getActiveVacancyCatalog(activeVacancies);
  const cityDetection = detectCity(text, catalog);
  const scored = catalog
    .map((vacancy) => {
      const scoredVacancy = scoreVacancy(text, vacancy);
      return {
        vacancy,
        score: scoredVacancy.score,
        sources: scoredVacancy.sources
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const alternatives = scored
    .filter((item) => item.score > 0)
    .slice(1, 4)
    .map((item) => ({ vacancyKey: item.vacancy.key, confidence: Math.min(0.95, 0.35 + (item.score * 0.08)) }));

  const normalizedText = normalizeText(text);
  const correctionHint = /(corrijo|quise decir|mejor|de hecho|actualizo|no es)/.test(normalizedText);
  const current = currentVacancyKey ? catalog.find((vacancy) => vacancy.key === currentVacancyKey) : null;

  if (current && !correctionHint) {
    const currentScore = scoreVacancy(text, current).score;
    if (!top || currentScore >= top.score) {
      return {
        vacancyDetection: {
          vacancyKey: current.key,
          confidence: currentScore > 0 ? 0.9 : 0.82,
          source: currentScore > 0 ? 'context+text' : 'context',
          alternatives,
          detected: true
        },
        cityDetection,
        suggestedNextAction: 'collect_or_confirm'
      };
    }
  }

  if (!top || top.score < 2) {
    return {
      vacancyDetection: {
        vacancyKey: null,
        confidence: 0,
        source: 'none',
        alternatives,
        detected: false
      },
      cityDetection,
      suggestedNextAction: 'ask_which_vacancy'
    };
  }

  const second = scored[1];
  if (second && second.score > 0 && Math.abs(top.score - second.score) <= 1) {
    return {
      vacancyDetection: {
        vacancyKey: null,
        confidence: 0.4,
        source: 'ambiguous',
        alternatives: [
          { vacancyKey: top.vacancy.key, confidence: Math.min(0.95, 0.35 + (top.score * 0.08)) },
          { vacancyKey: second.vacancy.key, confidence: Math.min(0.95, 0.35 + (second.score * 0.08)) }
        ],
        detected: false
      },
      cityDetection,
      suggestedNextAction: 'ask_which_vacancy'
    };
  }

  return {
    vacancyDetection: {
      vacancyKey: top.vacancy.key,
      confidence: Math.min(0.98, 0.4 + (top.score * 0.08)),
      source: top.sources[0] || 'text',
      alternatives,
      detected: true
    },
    cityDetection,
    suggestedNextAction: 'collect_or_confirm'
  };
}

export function buildVacancyGreeting(vacancy) {
  if (!vacancy) return null;
  return [
    'Hola, gracias por comunicarte con LoginPro.',
    `Te comparto la información de la oferta: *${vacancy.title || 'Vacante'}* (${vacancy.city || 'Ciudad por confirmar'}).`,
    vacancy.botIntroText || 'Estamos validando postulaciones para esta oferta.',
    vacancy.requirementsSummary ? `Requisitos clave: ${vacancy.requirementsSummary}` : null,
    'Si deseas continuar, respóndeme y te solicitaré tus datos.'
  ].filter(Boolean).join('\n\n');
}

export { DEFAULT_NEUTRAL_VACANCY_PROMPT };
