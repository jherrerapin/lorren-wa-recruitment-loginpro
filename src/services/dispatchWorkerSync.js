import { normalizeTransportMode } from './transportMode.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

async function resolveCandidateBranch(prisma, vacancy) {
  const branch = vacancy?.operation?.city;
  if (branch?.id) return branch;

  const legacyCityName = normalizeString(vacancy?.city);
  if (!legacyCityName) return null;
  return prisma.city.findFirst({
    where: { name: { equals: legacyCityName, mode: 'insensitive' } },
    select: { id: true, name: true }
  });
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
      vacancy: {
        select: {
          id: true,
          city: true,
          operation: {
            select: {
              city: { select: { id: true, name: true } }
            }
          }
        }
      }
    }
  });

  if (!candidate) return null;

  const normalizedTransportMode = normalizeTransportMode(candidate.transportMode);
  const branch = await resolveCandidateBranch(prisma, candidate.vacancy);

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
      operationalStatus: 'CONTRATADO'
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
      operationalStatus: 'CONTRATADO'
    }
  });

  // La vacante deja de ser autoridad de disponibilidad para Despacho. La relación
  // DispatchWorkerVacancy se conserva en el esquema solo como legado de transición;
  // nuevas sincronizaciones asignan exclusivamente la sucursal de la operación.
  if (branch?.id) {
    await prisma.dispatchWorkerCity.upsert({
      where: { workerId_cityId: { workerId: worker.id, cityId: branch.id } },
      create: { workerId: worker.id, cityId: branch.id },
      update: {}
    });
  }

  return worker;
}