from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {count}')
    return text.replace(old, new, 1)


test_path = Path('test/vacancyDashboardSearchExpansion.test.js')
test_source = test_path.read_text(encoding='utf-8')

test_source = replace_once(
    test_source,
    """} from '../src/services/vacancyDashboardSearchExpansion.js';
""",
    """} from '../src/services/vacancyDashboardSearchExpansion.js';
import {
  applyVacancyCandidateRegistrationPolicy,
  buildCandidateRegistrationCreatedAtWhere,
  buildVacancyRegistrationCandidateWhere,
  compareCandidatesByRegistrationDesc,
  filterAndSortCandidatesByRegistration,
  normalizeCandidateRegistrationRange,
  normalizeVacancyRegistrationDateFilters
} from '../src/services/vacancyCandidateRegistrationPolicy.js';
""",
    'import de política en contrato existente'
)

test_source = replace_once(
    test_source,
    """    ['candidate-other-date', 'candidate-unrelated']
""",
    """    ['candidate-unrelated', 'candidate-other-date']
""",
    'orden estable del contrato anterior'
)

extra_tests = r'''

function registrationCandidate(id, createdAt) {
  return { id, createdAt };
}

test('ordena postulados desde el registro más reciente al más antiguo', () => {
  const candidates = [
    registrationCandidate('old', '2026-07-01T15:00:00.000Z'),
    registrationCandidate('new', '2026-07-31T15:00:00.000Z'),
    registrationCandidate('middle', '2026-07-15T15:00:00.000Z')
  ];
  assert.deepEqual([...candidates].sort(compareCandidatesByRegistrationDesc).map((item) => item.id), [
    'new', 'middle', 'old'
  ]);
});

test('normaliza rangos invertidos y descarta fechas inexistentes', () => {
  assert.deepEqual(
    normalizeCandidateRegistrationRange({ dateFrom: '2026-07-31', dateTo: '2026-07-01' }),
    { dateFrom: '2026-07-01', dateTo: '2026-07-31' }
  );
  assert.deepEqual(
    normalizeCandidateRegistrationRange({ dateFrom: '2026-02-31', dateTo: 'texto' }),
    { dateFrom: '', dateTo: '' }
  );
});

test('construye días inclusivos en la zona horaria de Colombia', () => {
  const where = buildCandidateRegistrationCreatedAtWhere({ dateFrom: '2026-07-24', dateTo: '2026-07-24' });
  assert.equal(where.gte.toISOString(), '2026-07-24T05:00:00.000Z');
  assert.equal(where.lte.toISOString(), '2026-07-25T04:59:59.999Z');
});

test('filtra el rango antes de ordenar y antes del límite visual', () => {
  const result = filterAndSortCandidatesByRegistration([
    registrationCandidate('before', '2026-07-24T04:59:59.999Z'),
    registrationCandidate('first', '2026-07-24T05:00:00.000Z'),
    registrationCandidate('last', '2026-07-25T04:59:59.999Z'),
    registrationCandidate('after', '2026-07-25T05:00:00.000Z')
  ], { dateFrom: '2026-07-24', dateTo: '2026-07-24' });

  assert.deepEqual(result.map((item) => item.id), ['last', 'first']);
});

test('interpreta rangos independientes por vacante', () => {
  assert.deepEqual(normalizeVacancyRegistrationDateFilters({
    vr_vacancyA_dateFrom: '2026-07-01',
    vr_vacancyA_dateTo: '2026-07-10',
    vr_vacancyB_dateFrom: '2026-08-01',
    unrelated: 'ignore'
  }), {
    vacancyA: { dateFrom: '2026-07-01', dateTo: '2026-07-10' },
    vacancyB: { dateFrom: '2026-08-01', dateTo: '' }
  });
});

test('aplica la política a postulados sin cambiar el orden de entrevistas', () => {
  const vacancy = {
    registeredNoBooking: [registrationCandidate('r-old', '2026-07-01T15:00:00Z'), registrationCandidate('r-new', '2026-07-10T15:00:00Z')],
    registeredComplete: [registrationCandidate('c-new', '2026-07-11T15:00:00Z')],
    completeWithoutCv: [registrationCandidate('cv-old', '2026-06-01T15:00:00Z')],
    approvedCandidates: [registrationCandidate('a-new', '2026-07-12T15:00:00Z')],
    contractedCandidates: [registrationCandidate('h-new', '2026-07-13T15:00:00Z')],
    bookingsToday: [{ id: 'booking-1', scheduledAt: '2026-07-01T12:00:00Z' }]
  };

  applyVacancyCandidateRegistrationPolicy(vacancy, { dateFrom: '2026-07-05', dateTo: '2026-07-31' });
  assert.deepEqual(vacancy.registeredNoBooking.map((item) => item.id), ['r-new']);
  assert.deepEqual(vacancy.registeredComplete.map((item) => item.id), ['c-new']);
  assert.deepEqual(vacancy.completeWithoutCv, []);
  assert.deepEqual(vacancy.approvedCandidates.map((item) => item.id), ['a-new']);
  assert.deepEqual(vacancy.contractedCandidates.map((item) => item.id), ['h-new']);
  assert.deepEqual(vacancy.bookingsToday.map((item) => item.id), ['booking-1']);
});

test('construye condiciones de búsqueda por vacante y rango de registro', () => {
  const where = buildVacancyRegistrationCandidateWhere('vacancy-1', {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31'
  });
  assert.equal(where.vacancyId, 'vacancy-1');
  assert.equal(where.createdAt.gte.toISOString(), '2026-07-01T05:00:00.000Z');
  assert.equal(where.createdAt.lte.toISOString(), '2026-08-01T04:59:59.999Z');
});
'''

test_source = (test_source.rstrip() + extra_tests).rstrip() + '\n'
test_path.write_text(test_source, encoding='utf-8')

separate_test = Path('test/vacancyCandidateRegistrationPolicy.test.js')
if not separate_test.exists():
    raise SystemExit('No existe el contrato temporal que debía consolidarse')
separate_test.unlink()
