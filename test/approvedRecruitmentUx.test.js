import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';
import {
  enhanceApprovedRecruitmentUx,
  vacancyStatusFilterDefinitions
} from '../src/services/approvedRecruitmentUx.js';
import { normalizeInterviewOutreachConfig } from '../src/routes/admin.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function approvedClientScriptBody(html = '') {
  const match = String(html).match(/<script\s+data-approved-recruitment-ux>([\s\S]*?)<\/script>/i);
  return match?.[1] || '';
}

function renderInterviewOutreach(role = 'admin') {
  return ejs.render(readSource('src/views/outreachApproved.ejs'), {
    role,
    canAccessDispatch: false,
    candidates: [{
      id: 'candidate-example-1',
      fullName: 'Persona Ejemplo',
      phone: '3000000000',
      vacancyId: 'vacancy-example-1',
      createdAt: new Date('2026-08-25T12:00:00.000Z'),
      vacancy: {
        id: 'vacancy-example-1',
        title: 'Vacante de ejemplo',
        role: 'Auxiliar',
        city: 'Ciudad de ejemplo'
      }
    }],
    cityOptions: ['Ciudad de ejemplo'],
    vacancyOptions: [{
      id: 'vacancy-example-1',
      city: 'Ciudad de ejemplo',
      label: 'Ciudad de ejemplo · Vacante de ejemplo'
    }],
    outreachFilters: {
      city: 'Ciudad de ejemplo',
      vacancyId: 'vacancy-example-1'
    },
    outreachConfig: {
      templateName: 'citacion_entrevista_loginpro',
      templateLanguage: 'es_CO'
    },
    coordinatorContact: {
      name: 'Coordinación Ejemplo',
      apiPhone: '573000000000',
      displayPhone: '+57 300 000 0000'
    },
    templateReference: 'Hola {{1}}. Tu proceso para {{2}} será coordinado por {{3}}.',
    preparedRecipients: [],
    preparedSuccess: null,
    preparedError: null
  });
}

test('inyecta filtro Aprobados en el listado legado sin duplicarlo', () => {
  const html = '<html><body><table id="legacy-candidates-table"></table></body></html>';
  const enhanced = enhanceApprovedRecruitmentUx(html);
  assert.match(enhanced, /data-approved-recruitment-ux/);
  assert.match(enhanced, /approvedOnly/);
  assert.match(enhanced, /approvedLink\.textContent = 'Aprobados'/);
  assert.match(enhanced, /badge-aprobado/);
  assert.equal(enhanceApprovedRecruitmentUx(enhanced), enhanced);
});

test('los filtros por vacante son compartidos salvo Nuevos, que queda solo para DEV', () => {
  const recruiterFilters = vacancyStatusFilterDefinitions('admin');
  const devFilters = vacancyStatusFilterDefinitions('dev');

  assert.deepEqual(
    recruiterFilters.map(({ scope, label }) => [scope, label]),
    [
      ['registered', 'Registrados'],
      ['approved', 'Aprobados'],
      ['contacted', 'Contactados'],
      ['contracted', 'Contratados'],
      ['rejected', 'Rechazados']
    ]
  );
  assert.equal(recruiterFilters.some(({ scope }) => scope === 'new'), false);
  assert.deepEqual(
    devFilters.map(({ scope }) => scope),
    ['registered', 'approved', 'new', 'contacted', 'contracted', 'rejected']
  );
});

test('cada panel de vacante recibe navegación de estado con su vacancyId', () => {
  const html = [
    '<html><body>',
    '<section class="vacancy-panel" data-vacancy-panel="vacancy-example-1">',
    '<div class="vacancy-header"></div>',
    '<div class="vacancy-role">Auxiliar — Ciudad de ejemplo</div>',
    '</section>',
    '<section class="vacancy-panel" data-vacancy-panel="vacancy-example-2">',
    '<div class="vacancy-header"></div>',
    '<div class="vacancy-role">Operador — Otra ciudad</div>',
    '</section>',
    '</body></html>'
  ].join('');
  const enhanced = enhanceApprovedRecruitmentUx(html);

  assert.match(enhanced, /data-vacancy-status-filters/);
  assert.match(enhanced, /panel\.dataset\.vacancyPanel/);
  assert.match(enhanced, /url\.searchParams\.set\('vacancyId', vacancyId\)/);
  assert.match(enhanced, /filter\.approvedOnly/);
  assert.match(enhanced, /url\.searchParams\.set\('approvedOnly', '1'\)/);
  assert.match(enhanced, /isDevUi \? devVacancyStatusFilters : recruiterVacancyStatusFilters/);
  assert.match(enhanced, /a\[href="\/admin\/monitor"\]/);
});

test('el listado filtrado por vacante conserva selección masiva usando la autoridad existente', () => {
  const html = [
    '<html><body>',
    '<table id="legacy-candidates-table"><tbody>',
    '<tr><td>fecha</td><td>Persona Uno</td><td></td><td></td><td></td><td></td><td></td><td></td><td><span class="badge badge-registrado">Registrado</span></td><td></td><td><a class="link-detail" href="/admin/candidates/candidate-example-1">Ver</a></td></tr>',
    '<tr><td>fecha</td><td>Persona Dos</td><td></td><td></td><td></td><td></td><td></td><td></td><td><span class="badge badge-aprobado">Aprobado</span></td><td></td><td><a class="link-detail" href="/admin/candidates/candidate-example-2">Ver</a></td></tr>',
    '</tbody></table>',
    '</body></html>'
  ].join('');
  const enhanced = enhanceApprovedRecruitmentUx(html);
  const script = approvedClientScriptBody(enhanced);
  const source = readSource('src/services/approvedRecruitmentUx.js');

  assert.match(source, /historicalBulkCandidateStatuses/);
  assert.match(script, /recruiterBulkStatuses = \["REGISTRADO","APROBADO","CONTACTADO","RECHAZADO"\]/);
  assert.match(script, /devBulkStatuses = \["NUEVO","REGISTRADO","APROBADO","CONTACTADO","RECHAZADO"\]/);
  assert.match(script, /currentUrl\.searchParams\.get\('vacancyId'\)/);
  assert.match(script, /currentUrl\.searchParams\.get\('status'\)/);
  assert.match(script, /data-filtered-vacancy-bulk-status/);
  assert.match(script, /data-filtered-candidate-id/);
  assert.match(script, /Seleccionar visibles/);
  assert.match(script, /Aplicar a seleccionados/);
  assert.match(script, /fetch\('\/admin\/candidates\/' \+ encodeURIComponent\(candidateId\) \+ '\/status'/);
  assert.match(script, /body\.set\('returnTo', returnTo\)/);
  assert.doesNotMatch(script, /\/bulk-status/);
  assert.doesNotMatch(script, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotThrow(() => new Function(script));
});

test('la selección masiva filtrada ignora filas ocultas y contratados', () => {
  const html = '<html><body><table id="legacy-candidates-table"><tbody><tr><td></td></tr></tbody></table></body></html>';
  const script = approvedClientScriptBody(enhanceApprovedRecruitmentUx(html));

  assert.match(script, /if \(row\.hidden \|\| row\.querySelector\('\.badge-contratado'\)\) return;/);
  assert.match(script, /visibleCandidateCheckboxes/);
  assert.match(script, /return Boolean\(row\) && !row\.hidden;/);
  assert.match(script, /Contratados se gestionan individualmente/);
  assert.equal(
    script.indexOf('row.hidden = !isApproved') < script.indexOf('installFilteredBulkStatusControls(legacyTable)'),
    true
  );
});

test('el enlace Mensajes a aprobados se contextualiza por vacante y sucursal', () => {
  const html = '<html><body><div data-vacancy-panel="vac-123"><div class="vacancy-role">Auxiliar — Medellín</div><a href="/admin/outreach/approved">Mensajes a aprobados</a></div></body></html>';
  const enhanced = enhanceApprovedRecruitmentUx(html);
  assert.match(enhanced, /panel\.dataset\.vacancyPanel/);
  assert.match(enhanced, /searchParams\.set\('city', city\)/);
  assert.match(enhanced, /searchParams\.set\('vacancyId', vacancyId\)/);
});

test('Outreach aprobado encadena Sucursal -> Vacante en el navegador', () => {
  const view = readSource('src/views/outreachApproved.ejs');
  assert.match(view, /<label for="city">Sucursal<\/label>/);
  assert.match(view, /const citySelect = document\.getElementById\('city'\)/);
  assert.match(view, /const vacancySelect = document\.getElementById\('vacancyId'\)/);
  assert.match(view, /option\.dataset\.city/);
  assert.match(view, /option\.hidden = !visible/);
  assert.match(view, /option\.disabled = !visible/);
  assert.match(view, /citySelect\.addEventListener\('change', syncVacanciesToCity\)/);
});

test('ADMIN no diligencia ni visualiza nombre o teléfono del gestionante en el módulo', () => {
  const html = renderInterviewOutreach('admin');

  assert.doesNotMatch(html, /Plantilla oficial de Meta/);
  assert.doesNotMatch(html, /Nombre de plantilla/);
  assert.doesNotMatch(html, /Idioma Meta/);
  assert.doesNotMatch(html, /Quick Reply/);
  assert.doesNotMatch(html, /payloads/);
  assert.doesNotMatch(html, /InterviewBooking/);
  assert.doesNotMatch(html, /API oficial/);
  assert.doesNotMatch(html, /Enviar citaciones por Meta/);
  assert.doesNotMatch(html, /Citaciones aceptadas por Meta/);
  assert.doesNotMatch(html, /name="templateName"|name="templateLanguage"/);
  assert.doesNotMatch(html, /citacion_entrevista_loginpro|es_CO/);
  assert.doesNotMatch(html, /interviewDate|interviewTime|interviewAddress/);
  assert.doesNotMatch(html, /Fecha de entrevista|Hora de entrevista|Dirección de citación/);
  assert.doesNotMatch(html, /id="coordinatorName"|id="coordinatorPhone"/);
  assert.doesNotMatch(html, /Coordinación Ejemplo|\+57 300 000 0000/);
  assert.match(html, /El gestionante y su WhatsApp se toman automáticamente del usuario que realiza este envío/);
  assert.match(html, />Enviar citaciones<\/button>/);
});

test('backend conserva solo la configuración canónica y toma coordinador desde AppUser autenticado', () => {
  const config = normalizeInterviewOutreachConfig({});
  const adminSource = readSource('src/routes/admin.js');

  assert.deepEqual(config, {
    templateName: 'citacion_entrevista_loginpro',
    templateLanguage: 'es_CO'
  });
  assert.equal(Object.hasOwn(config, 'interviewDate'), false);
  assert.equal(Object.hasOwn(config, 'interviewTime'), false);
  assert.equal(Object.hasOwn(config, 'interviewAddress'), false);
  assert.match(adminSource, /req\.userId \|\| req\.session\?\.userId/);
  assert.match(adminSource, /displayName:\s*true, recoveryPhone:\s*true, dispatchAlertPhone:\s*true/);
  assert.match(adminSource, /const dispatchPhone = normalizeCoordinatorContactPhone\(user\?\.dispatchAlertPhone\)/);
  assert.match(adminSource, /const recoveryPhone = normalizeCoordinatorContactPhone\(user\?\.recoveryPhone\)/);
  assert.doesNotMatch(adminSource, /req\.body\.(?:coordinatorName|coordinatorPhone)/);
});

test('DEV documenta tres variables y el CTA dinámico al coordinador sin campos manuales', () => {
  const html = renderInterviewOutreach('dev');

  assert.match(html, /Plantilla oficial de Meta/);
  assert.match(html, /Nombre de plantilla/);
  assert.match(html, /Idioma Meta/);
  assert.match(html, /tres variables/);
  assert.match(html, /Contactar a coordinador/);
  assert.match(html, /https:\/\/wa\.me\/\{\{1\}\}/);
  assert.doesNotMatch(html, /Quick Reply|Confirmo asistencia|No puedo asistir/);
  assert.doesNotMatch(html, /id="coordinatorName"|id="coordinatorPhone"/);
  assert.match(html, /id="templateName" name="templateName" value="citacion_entrevista_loginpro"/);
  assert.match(html, /id="templateLanguage" name="templateLanguage" value="es_CO"/);
});

test('la mejora global se aplica a las respuestas HTML', () => {
  const source = readSource('src/registerGlobalFavicon.js');
  assert.match(source, /enhanceApprovedRecruitmentUx/);
  assert.match(source, /enhanceApprovedRecruitmentUx\(/);
});
