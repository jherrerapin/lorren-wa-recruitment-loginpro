import {
  groupCandidateReviewResults,
  reviewVacancyCandidates as reviewVacancyCandidatesBase
} from './cvIntelligence.js';

export const CV_REVIEW_ELIGIBLE_STATUSES = Object.freeze([
  'REGISTRADO',
  'CONTACTADO',
  'APROBADO'
]);

function compact(value = '') {
  return String(value ?? '').trim();
}

function validDateOnly(value = '') {
  const text = compact(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function colombiaRegistrationDayBounds(dateOnly) {
  if (!validDateOnly(dateOnly)) return null;
  const [year, month, day] = dateOnly.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0)),
    end: new Date(Date.UTC(year, month - 1, day + 1, 4, 59, 59, 999))
  };
}

export function normalizeCvReviewDateRange(source = {}) {
  const rawFrom = compact(source.dateFrom);
  const rawTo = compact(source.dateTo);

  if ((rawFrom && !validDateOnly(rawFrom)) || (rawTo && !validDateOnly(rawTo))) {
    return {
      ok: false,
      reason: 'date_range_invalid',
      dateFrom: rawFrom,
      dateTo: rawTo,
      isActive: false,
      createdAtWhere: null
    };
  }

  if (rawFrom && rawTo && rawFrom > rawTo) {
    return {
      ok: false,
      reason: 'date_range_inverted',
      dateFrom: rawFrom,
      dateTo: rawTo,
      isActive: false,
      createdAtWhere: null
    };
  }

  const createdAtWhere = {};
  if (rawFrom) createdAtWhere.gte = colombiaRegistrationDayBounds(rawFrom).start;
  if (rawTo) createdAtWhere.lte = colombiaRegistrationDayBounds(rawTo).end;

  return {
    ok: true,
    reason: null,
    dateFrom: rawFrom,
    dateTo: rawTo,
    isActive: Boolean(rawFrom || rawTo),
    createdAtWhere: Object.keys(createdAtWhere).length ? createdAtWhere : null
  };
}

export function publicCvReviewDateRange(dateRange = {}) {
  return {
    dateFrom: compact(dateRange.dateFrom),
    dateTo: compact(dateRange.dateTo),
    isActive: Boolean(dateRange.isActive)
  };
}

export function cvReviewDateRangeLabel(dateRange = {}) {
  const from = compact(dateRange.dateFrom);
  const to = compact(dateRange.dateTo);
  if (from && to) return `postulados entre ${from} y ${to}`;
  if (from) return `postulados desde ${from}`;
  if (to) return `postulados hasta ${to}`;
  return 'todos los postulados elegibles de la vacante';
}

export function buildCvReviewCandidateWhere({ vacancyId, accessWhere = null, dateRange = {} } = {}) {
  const clauses = [];
  if (accessWhere && Object.keys(accessWhere).length) clauses.push(accessWhere);
  if (compact(vacancyId)) clauses.push({ vacancyId: compact(vacancyId) });
  clauses.push({ status: { in: [...CV_REVIEW_ELIGIBLE_STATUSES] } });
  clauses.push({
    OR: [
      { cvStorageKey: { not: null } },
      { cvData: { not: null } },
      { cvOriginalName: { not: null } }
    ]
  });
  if (dateRange.createdAtWhere) clauses.push({ createdAt: dateRange.createdAtWhere });
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

function mergeCandidateReviewWhere(originalWhere = {}, dateRange = {}) {
  if (!dateRange.createdAtWhere) return originalWhere;
  return {
    AND: [
      originalWhere || {},
      { createdAt: dateRange.createdAtWhere }
    ]
  };
}

function prismaScopedToRegistrationRange(prisma, dateRange) {
  if (!dateRange.createdAtWhere) return prisma;

  const candidateDelegate = prisma.candidate;
  const scopedCandidateDelegate = new Proxy(candidateDelegate, {
    get(target, property) {
      if (property === 'findMany') {
        return async (args = {}) => target.findMany({
          ...args,
          where: mergeCandidateReviewWhere(args.where, dateRange),
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  return new Proxy(prisma, {
    get(target, property) {
      if (property === 'candidate') return scopedCandidateDelegate;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function matchLevelFromScore(score) {
  const normalized = Math.max(0, Math.min(100, Number(score || 0)));
  if (normalized >= 75) return 'STRONG';
  if (normalized >= 45) return 'POSSIBLE';
  return 'LOW';
}

export function calibrateCvReviewResult(review = {}) {
  if (!review?.ok || !Array.isArray(review.results)) return review;

  const results = review.results.map((result) => {
    if (!result?.match) return result;
    const score = Math.max(0, Math.min(100, Number(result.match.score || 0)));
    return {
      ...result,
      match: {
        ...result.match,
        score,
        level: matchLevelFromScore(score)
      }
    };
  });
  const groups = groupCandidateReviewResults(results);

  return {
    ...review,
    results,
    groups,
    stats: {
      ...review.stats,
      total: results.length,
      strong: groups.strong.length,
      possible: groups.possible.length,
      low: groups.low.length,
      manual: groups.manual.length
    }
  };
}

export async function reviewVacancyCandidates(prisma, input = {}, options = {}) {
  const dateRange = normalizeCvReviewDateRange(input);
  if (!dateRange.ok) {
    return {
      ok: false,
      reason: dateRange.reason,
      dateRange: publicCvReviewDateRange(dateRange)
    };
  }

  const scopedPrisma = prismaScopedToRegistrationRange(prisma, dateRange);
  const review = await reviewVacancyCandidatesBase(scopedPrisma, {
    vacancyId: input.vacancyId,
    desiredProfile: input.desiredProfile
  }, options);

  return {
    ...calibrateCvReviewResult(review),
    dateRange: publicCvReviewDateRange(dateRange)
  };
}
