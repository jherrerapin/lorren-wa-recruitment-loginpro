import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCvReviewExportOwnerKey,
  loadCvReviewExportSnapshot,
  removeCvReviewExportSnapshot,
  storeCvReviewExportSnapshot
} from '../src/services/cvReviewExportStore.js';

test('la instantánea exportable solo puede leerse desde la misma sesión', () => {
  const snapshot = { vacancy: { id: 'vacancy-session' }, groups: { strong: [] } };
  const token = storeCvReviewExportSnapshot(snapshot, { ownerKey: 'session-owner-a' });

  assert.equal(loadCvReviewExportSnapshot(token, { ownerKey: 'session-owner-a' }), snapshot);
  assert.equal(loadCvReviewExportSnapshot(token, { ownerKey: 'session-owner-b' }), null);
  assert.equal(loadCvReviewExportSnapshot('token-inexistente', { ownerKey: 'session-owner-a' }), null);
});

test('el propietario se obtiene primero desde sessionID y no desde datos enviados por el cliente', () => {
  assert.equal(getCvReviewExportOwnerKey({ sessionID: 'session-primary', session: { userId: 'user-fallback' } }), 'session-primary');
  assert.equal(getCvReviewExportOwnerKey({ session: { user: { id: 'user-session' } } }), 'user-session');
  assert.equal(getCvReviewExportOwnerKey({}), null);
});

test('una sesión distinta no puede eliminar una instantánea ajena', () => {
  const snapshot = { vacancy: { id: 'vacancy-remove' } };
  const token = storeCvReviewExportSnapshot(snapshot, { ownerKey: 'session-remove-a' });

  assert.equal(removeCvReviewExportSnapshot(token, { ownerKey: 'session-remove-b' }), false);
  assert.equal(loadCvReviewExportSnapshot(token, { ownerKey: 'session-remove-a' }), snapshot);
  assert.equal(removeCvReviewExportSnapshot(token, { ownerKey: 'session-remove-a' }), true);
  assert.equal(loadCvReviewExportSnapshot(token, { ownerKey: 'session-remove-a' }), null);
});
