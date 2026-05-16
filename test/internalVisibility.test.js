import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MessageDirection, MessageType } from '@prisma/client';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { fetchMonitorMessages } from '../src/routes/admin.js';

test('detail.ejs filtra mensajes internos del administrador antes de ordenar el historial visible', async () => {
  const detailTemplate = await fs.readFile(path.resolve(process.cwd(), 'src/views/detail.ejs'), 'utf8');

  assert.match(detailTemplate, /const visibleMessages = \(candidate\.messages \|\| \[\]\)\.filter/);
  assert.match(detailTemplate, /payload\.target !== 'admin_supervisor'/);
  assert.match(detailTemplate, /payload\.visibility !== 'internal'/);
  assert.match(detailTemplate, /payload\.neverSendToCandidate !== true/);
  assert.match(detailTemplate, /payload\.source !== 'admin_manual_review_request'/);
  assert.match(detailTemplate, /Responde por este chat con la información que Lórren debe enviar al candidato/);
  assert.match(detailTemplate, /const sorted = visibleMessages\.slice\(\)\.sort/);
  assert.doesNotMatch(detailTemplate, /const sorted = candidate\.messages\.slice\(\)\.sort/);
});

test('fetchMonitorMessages excluye mensajes internos del supervisor del monitor general', async () => {
  const prisma = createMockPrisma({
    messages: [{
      id: 'visible-monitor-message',
      candidateId: 'cand-monitor',
      direction: MessageDirection.INBOUND,
      messageType: MessageType.TEXT,
      body: 'Mensaje visible del candidato',
      createdAt: new Date('2026-05-16T10:04:00Z'),
      rawPayload: {}
    }, {
      id: 'internal-monitor-target',
      candidateId: 'admin-candidate',
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body: 'Alerta interna al administrador',
      createdAt: new Date('2026-05-16T10:03:00Z'),
      rawPayload: { target: 'admin_supervisor', source: 'admin_manual_review_request' }
    }, {
      id: 'internal-monitor-visibility',
      candidateId: 'admin-candidate',
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body: 'Otra alerta interna',
      createdAt: new Date('2026-05-16T10:02:00Z'),
      rawPayload: { visibility: 'internal' }
    }]
  });

  const messages = await fetchMonitorMessages(prisma);

  assert.deepEqual(messages.map((message) => message.id), ['visible-monitor-message']);
});
