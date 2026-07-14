import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateAccessWhere,
  buildRecruiterUsernameBase,
  buildUniqueRecruiterUsername,
  buildVacancyAccessWhere,
  canAccessCandidate,
  canAccessVacancy,
  describeUserScope,
  encodeUserAccessCities,
  encodeUserAccessSelection,
  getAccessContext,
  normalizeUserAccessCities,
  normalizeUserAccessScope,
  normalizeUserAccessVacancyIds
} from '../src/services/appUsers.js';

test('normalizeUserAccessScope cae a ALL cuando recibe un valor invalido', () => {
  assert.equal(normalizeUserAccessScope('city'), 'CITY');
  assert.equal(normalizeUserAccessScope('vacancy'), 'VACANCY');
  assert.equal(normalizeUserAccessScope('cualquier-cosa'), 'ALL');
});

test('normaliza ciudades antiguas y selecciones nuevas sin romper compatibilidad', () => {
  assert.deepEqual(normalizeUserAccessCities('Bogota'), ['Bogota']);
  assert.deepEqual(normalizeUserAccessCities('["Bogota","Ibague","Bogota"]'), ['Bogota', 'Ibague']);
  assert.deepEqual(normalizeUserAccessCities(['Neiva', 'Ibague']), ['Neiva', 'Ibague']);
  assert.equal(encodeUserAccessCities(['Bogota']), 'Bogota');
  assert.equal(encodeUserAccessCities(['Bogota', 'Ibague']), '["Bogota","Ibague"]');

  const encodedSelection = encodeUserAccessSelection({
    cities: ['Bogota', 'Neiva'],
    vacancyIds: ['vac-1', 'vac-3', 'vac-1']
  });
  assert.deepEqual(normalizeUserAccessCities(encodedSelection), ['Bogota', 'Neiva']);
  assert.deepEqual(normalizeUserAccessVacancyIds(encodedSelection), ['vac-1', 'vac-3']);
  assert.deepEqual(normalizeUserAccessVacancyIds(encodedSelection, 'vac-1'), ['vac-1', 'vac-3']);
});

test('buildRecruiterUsernameBase crea usernames segun el alcance', () => {
  assert.equal(buildRecruiterUsernameBase({ accessScope: 'ALL' }), 'reclutador-general');
  assert.equal(buildRecruiterUsernameBase({ accessScope: 'CITY', scopeCity: 'Bogota' }), 'reclutador-bogota');
  assert.equal(
    buildRecruiterUsernameBase({ accessScope: 'CITY', scopeCity: '["Ibague","Neiva"]' }),
    'reclutador-ibague'
  );
  assert.equal(
    buildRecruiterUsernameBase({ accessScope: 'VACANCY', vacancyTitle: 'Coordinador de Operaciones' }),
    'reclutador-coordinador-de-operaciones'
  );
});

test('buildUniqueRecruiterUsername agrega consecutivo cuando el username ya existe', async () => {
  const prisma = {
    appUser: {
      async findMany() {
        return [
          { username: 'reclutador-general' },
          { username: 'reclutador-general-2' }
        ];
      }
    }
  };

  const username = await buildUniqueRecruiterUsername(prisma, { accessScope: 'ALL' });
  assert.equal(username, 'reclutador-general-3');
});

test('helpers de acceso mantienen compatibilidad con una ciudad y una vacante antiguas', () => {
  const cityContext = getAccessContext({
    userRole: 'admin',
    userAccessScope: 'CITY',
    userAccessCity: 'Ibague'
  });
  const vacancyContext = getAccessContext({
    userRole: 'admin',
    userAccessScope: 'VACANCY',
    userAccessVacancyId: 'vac-1'
  });

  assert.deepEqual(buildVacancyAccessWhere(cityContext), { city: { in: ['Ibague'] } });
  assert.deepEqual(buildCandidateAccessWhere(vacancyContext), { vacancyId: 'vac-1' });

  assert.equal(canAccessVacancy(cityContext, { id: 'vac-9', city: 'Ibague' }), true);
  assert.equal(canAccessVacancy(cityContext, { id: 'vac-9', city: 'Bogota' }), false);
  assert.equal(canAccessVacancy(vacancyContext, { id: 'vac-1', city: 'Bogota' }), true);
  assert.equal(canAccessVacancy(vacancyContext, { id: 'vac-2', city: 'Bogota' }), false);

  assert.equal(canAccessCandidate(cityContext, { vacancyId: 'vac-9', vacancy: { id: 'vac-9', city: 'Ibague' } }), true);
  assert.equal(canAccessCandidate(cityContext, { vacancyId: 'vac-9', vacancy: { id: 'vac-9', city: 'Bogota' } }), false);
  assert.equal(canAccessCandidate(vacancyContext, { vacancyId: 'vac-1', vacancy: { id: 'vac-1', city: 'Bogota' } }), true);
  assert.equal(canAccessCandidate(vacancyContext, { vacancyId: 'vac-2', vacancy: { id: 'vac-2', city: 'Bogota' } }), false);
});

test('una ciudad seleccionada no concede todas sus vacantes', () => {
  const selection = encodeUserAccessSelection({
    cities: ['Bogota'],
    vacancyIds: ['vac-bog-1', 'vac-bog-3']
  });
  const context = getAccessContext({
    userRole: 'admin',
    userAccessScope: 'VACANCY',
    userAccessCity: selection,
    userAccessVacancyId: 'vac-bog-1'
  });

  assert.deepEqual(context.cities, ['Bogota']);
  assert.deepEqual(context.vacancyIds, ['vac-bog-1', 'vac-bog-3']);
  assert.deepEqual(buildVacancyAccessWhere(context), {
    id: { in: ['vac-bog-1', 'vac-bog-3'] }
  });
  assert.deepEqual(buildCandidateAccessWhere(context), {
    vacancyId: { in: ['vac-bog-1', 'vac-bog-3'] }
  });

  assert.equal(canAccessVacancy(context, { id: 'vac-bog-1', city: 'Bogota' }), true);
  assert.equal(canAccessVacancy(context, { id: 'vac-bog-2', city: 'Bogota' }), false);
  assert.equal(canAccessVacancy(context, { id: 'vac-nei-1', city: 'Neiva' }), false);

  assert.equal(canAccessCandidate(context, { vacancyId: 'vac-bog-3', vacancy: { id: 'vac-bog-3', city: 'Bogota' } }), true);
  assert.equal(canAccessCandidate(context, { vacancyId: 'vac-bog-2', vacancy: { id: 'vac-bog-2', city: 'Bogota' } }), false);
});

test('permite seleccionar vacantes concretas de varias ciudades', () => {
  const selection = encodeUserAccessSelection({
    cities: ['Bogota', 'Neiva'],
    vacancyIds: ['vac-bog-1', 'vac-nei-2']
  });
  const context = getAccessContext({
    userRole: 'admin',
    userAccessScope: 'VACANCY',
    userAccessCity: selection,
    userAccessVacancyId: 'vac-bog-1'
  });

  assert.equal(canAccessVacancy(context, { id: 'vac-bog-1', city: 'Bogota' }), true);
  assert.equal(canAccessVacancy(context, { id: 'vac-nei-2', city: 'Neiva' }), true);
  assert.equal(canAccessVacancy(context, { id: 'vac-nei-3', city: 'Neiva' }), false);
  assert.equal(canAccessVacancy(context, { id: 'vac-iba-1', city: 'Ibague' }), false);
});

test('describeUserScope resume el alcance visible del usuario', () => {
  assert.equal(describeUserScope({ accessScope: 'ALL' }), 'Todas las vacantes');
  assert.equal(describeUserScope({ accessScope: 'CITY', scopeCity: 'Bogota' }), 'Ciudad: Bogota');
  assert.equal(
    describeUserScope({ accessScope: 'CITY', scopeCity: '["Bogota","Neiva"]' }),
    'Ciudades: Bogota, Neiva'
  );
  assert.equal(
    describeUserScope({
      accessScope: 'VACANCY',
      scopeCity: encodeUserAccessSelection({ cities: ['Bogota'], vacancyIds: ['vac-1', 'vac-2'] }),
      scopeVacancyId: 'vac-1'
    }),
    '2 vacantes seleccionadas'
  );
  assert.equal(
    describeUserScope({
      accessScope: 'VACANCY',
      scopeVacancyId: 'vac-1',
      scopeVacancy: { title: 'Auxiliar de Bodega' }
    }),
    'Vacante: Auxiliar de Bodega'
  );
});
