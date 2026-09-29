import test from 'node:test';
import assert from 'node:assert/strict';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';

test('TEST-RC-CANONICAL-WRITER: la captura canónica falla cerrada sin consentimiento ACCEPTED', async () => {
  const updates = [];
  const candidate = {
    id: 'TEST-RC-CANDIDATE',
    dataConsentStatus: 'PENDING',
    fullName: null,
    documentNumber: null,
    age: null
  };

  const result = await captureConsentedProfileData({
    prisma: {
      candidate: {
        update: async ({ data }) => {
          updates.push(structuredClone(data));
          return { ...candidate, ...data };
        }
      }
    },
    candidate,
    currentText: 'Me llamo Nombre de Prueba, mi cédula es TEST-100000001 y tengo 30 años'
  });

  assert.deepEqual(updates, []);
  assert.equal(result.reason, 'consent_not_accepted');
  assert.deepEqual(result.capturedFields, []);
});
