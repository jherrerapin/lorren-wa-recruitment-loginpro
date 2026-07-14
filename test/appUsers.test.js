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
  getAccessContext,
  normalizeUserAccessScope,
  normalizeUserScopeCities,
  serializeUserScopeCities
} from '../src/services/appUsers.js';

test('normalizeUserAccessScope cae a ALL cuando recibe un valor invalido', () => {
  assert.equal(normalizeUserAccessScope('city'), 'CITY');
  assert.equal(normalizeUserAccessScope('vacancy'), 'VACANCY');
  assert.equal(normalizeUserAccessScope('cualquier-cosa'), 'ALL');
});

test('normaliza ciudades antiguas y múltiples sin duplicados', () => {
  assert.deepEqual(normalizeUserScopeCities('Bogota'), ['Bogota']);
  assert.deepEqual(normalizeUserScopeCities('["Bogota","Neiva","Bogota"]'), ['Bogota', 'Neiva']);
  assert.deepEqual(normalizeUserScopeCities(['Ibague', ' Neiva ', '']), ['Ibague', 'Neiva']);
  assert.equal(serializeUserScopeCities(['Bogota']), 'Bogota');
  assert.equal(serializeUserScopeCities(['Bogota', 'Neiva']), '["Bogota","Neiva"]');
});

test('buildRecruiterUsernameBase crea usernames segun el alcance', () => {
  assert.equal(buildRecruiterUsernameBase({ accessScope: 'ALL' }), 'reclutador-general');
  assert.equal(buildRecruiterUsernameBase({ accessScope: 'CITY', scopeCity: 'Bogota' }), 'reclutador-bogota');
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

test('helpers de acceso limitan ciudad y vacante correctamente', () => {
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

  assert.deepEqual(buildVacancyAccessWhere(cityContext), { city: 'Ibague' });
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

test('helpers de acceso aceptan varias ciudades en el mismo usuario', () => {
  const context = getAccessContext({
    userRole: 'admin',
    userAccessScope: 'CITY',
    userAccessCity: '["Ibague","Neiva"]'
  });

  assert.deepEqual(context.cities, ['Ibague', 'Neiva']);
  assert.deepEqual(buildVacancyAccessWhere(context), { city: { in: ['Ibague', 'Neiva'] } });
  assert.deepEqual(buildCandidateAccessWhere(context), {
    vacancy: { city: { in: ['Ibague', 'Neiva'] } }
  });
  assert.equal(canAccessVacancy(context, { id: 'vac-1', city: 'Ibague' }), true);
  assert.equal(canAccessVacancy(context, { id: 'vac-2', city: 'Neiva' }), true);
  assert.equal(canAccessVacancy(context, { id: 'vac-3', city: 'Bogota' }), false);
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
      scopeVacancyId: 'vac-1',
      scopeVacancy: { title: 'Auxiliar de Bodega' }
    }),
    'Vacante: Auxiliar de Bodega'
  );
});
