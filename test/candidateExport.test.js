import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportFilenameByScope,
  filterCandidatesByScope,
  isOperationallyRegistered,
  normalizeCandidateStatusForUI
} from '../src/services/candidateExport.js';

const baseCandidate = {
  id: 'cand-1',
  fullName: 'Ana Perez',
  documentType: 'CC',
  documentNumber: '123',
  age: 25,
  neighborhood: 'Picalena',
  experienceInfo: 'Sí',
  experienceTime: '6 meses',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Moto',
  status: 'REGISTRADO',
  cvData: Buffer.from('cv')
};

test('registered operativo exige campos completos + CV + no rechazado', () => {
  assert.equal(isOperationallyRegistered(baseCandidate), true);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, cvData: null }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'RECHAZADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, experienceTime: '' }), false);
});

test('legacy VALIDANDO/APROBADO se normalizan visualmente a REGISTRADO', () => {
  assert.equal(normalizeCandidateStatusForUI('VALIDANDO'), 'REGISTRADO');
  assert.equal(normalizeCandidateStatusForUI('APROBADO'), 'REGISTRADO');
  assert.equal(normalizeCandidateStatusForUI('CONTACTADO'), 'CONTACTADO');
});

test('scope registered incluye estados legacy cuando cumplen criterio operativo', () => {
  const candidates = [
    { ...baseCandidate, id: 'reg', status: 'REGISTRADO' },
    { ...baseCandidate, id: 'legacy-validando', status: 'VALIDANDO' },
    { ...baseCandidate, id: 'legacy-aprobado', status: 'APROBADO' },
    { ...baseCandidate, id: 'new-incomplete', status: 'NUEVO', cvData: null },
    { ...baseCandidate, id: 'rejected', status: 'RECHAZADO' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'registered').map((c) => c.id),
    ['reg', 'legacy-validando', 'legacy-aprobado']
  );
  assert.deepEqual(filterCandidatesByScope(candidates, 'new').map((c) => c.id), ['new-incomplete']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'rejected').map((c) => c.id), ['rejected']);
});

test('nombre de archivo de exportación usa scopes operativos', () => {
  assert.match(exportFilenameByScope('contacted'), /^candidatos_contacted_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(exportFilenameByScope('invalid-scope'), /^candidatos_all_\d{4}-\d{2}-\d{2}\.xlsx$/);
});
