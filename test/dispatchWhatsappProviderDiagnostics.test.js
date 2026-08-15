import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  dispatchWhatsappProviderFailureCode,
  sanitizeDispatchWhatsappProviderDiagnostic
} from '../src/services/dispatchWhatsappAssignmentService.js';

test('conserva código y subcódigo Meta sin incluir datos del destinatario', () => {
  const error = {
    response: {
      data: {
        error: {
          code: 132001,
          error_subcode: 2494073,
          message: 'Template name does not exist in the translation'
        }
      }
    }
  };

  assert.equal(
    dispatchWhatsappProviderFailureCode(error),
    'dispatch_whatsapp_provider_error_meta_132001_sub_2494073'
  );
});

test('mantiene el código genérico cuando el proveedor no entrega identidad numérica', () => {
  assert.equal(
    dispatchWhatsappProviderFailureCode(new Error('timeout')),
    'dispatch_whatsapp_provider_error'
  );
});

test('el diagnóstico visible en Railway elimina identificadores largos y secretos', () => {
  const diagnostic = sanitizeDispatchWhatsappProviderDiagnostic(
    'Meta rechazó la operación: recipient=987654321098765 access_token=secret-test-value'
  );
  assert.match(diagnostic, /recipient=\[redacted\]/);
  assert.match(diagnostic, /access_token=\[redacted\]/);
  assert.doesNotMatch(diagnostic, /987654321098765/);
  assert.doesNotMatch(diagnostic, /secret-test-value/);
});

test('el warning de proveedor usa solo el diagnóstico redacted', () => {
  const source = fs.readFileSync('src/services/dispatchWhatsappAssignmentService.js', 'utf8');
  assert.match(
    source,
    /console\.warn\('\[dispatch-wa-cloud\] Rechazo del proveedor al enviar asignación:', diagnostic\)/
  );
  assert.doesNotMatch(
    source,
    /Rechazo del proveedor al enviar asignación:[^\n]*(?:userId|assignmentId|phone|accessToken|payload)/
  );
});
