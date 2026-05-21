import { normalizeTransportMode } from './transportMode.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export async function upsertDispatchWorkerFromCandidate(prisma, candidateId) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      fullName: true,
      phone: true,
      documentType: true,
      documentNumber: true,
      locality: true,
      neighborhood: true,
      zone: true,
      transportMode: true,
      vacancyId: true,
      vacancy: { select: { id: true, city: true } }
    }
  });

  if (!candidate) return null;

  const normalizedTransportMode = normalizeTransportMode(candidate.transportMode);

  const worker = await prisma.dispatchWorker.upsert({
    where: { candidateId: candidate.id },
    create: {
      candidateId: candidate.id,
      fullName: normalizeString(candidate.fullName) || 'Sin nombre',
      phone: normalizeString(candidate.phone),
      documentType: normalizeString(candidate.documentType),
      documentNumber: normalizeString(candidate.documentNumber),
      residenceCity: normalizeString(candidate.zone) || normalizeString(candidate.vacancy?.city),
      residenceLocality: normalizeString(candidate.locality) || normalizeString(candidate.neighborhood),
      transportMode: normalizedTransportMode,
      source: 'CANDIDATE',
      operationalStatus: 'ACTIVE'
    },
    update: {
      fullName: normalizeString(candidate.fullName) || 'Sin nombre',
      phone: normalizeString(candidate.phone),
      documentType: normalizeString(candidate.documentType),
      documentNumber: normalizeString(candidate.documentNumber),
      residenceCity: normalizeString(candidate.zone) || normalizeString(candidate.vacancy?.city),
      residenceLocality: normalizeString(candidate.locality) || normalizeString(candidate.neighborhood),
      transportMode: normalizedTransportMode,
      source: 'CANDIDATE',
      operationalStatus: 'ACTIVE'
    }
  });

  if (candidate.vacancyId) {
    await prisma.dispatchWorkerVacancy.upsert({
      where: { workerId_vacancyId: { workerId: worker.id, vacancyId: candidate.vacancyId } },
      create: { workerId: worker.id, vacancyId: candidate.vacancyId },
      update: {}
    });
  }

  const cityNameCandidates = [candidate.zone, candidate.locality, candidate.vacancy?.city].map(normalizeString).filter(Boolean);
  for (const cityName of cityNameCandidates) {
    const city = await prisma.city.findFirst({ where: { name: { equals: cityName, mode: 'insensitive' } }, select: { id: true } });
    if (!city) continue;
    await prisma.dispatchWorkerCity.upsert({
      where: { workerId_cityId: { workerId: worker.id, cityId: city.id } },
      create: { workerId: worker.id, cityId: city.id },
      update: {}
    });
  }

  return worker;
}
