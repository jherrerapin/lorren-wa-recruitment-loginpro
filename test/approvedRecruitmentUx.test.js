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
      address: 'Sede de ejemplo',
      label: 'Ciudad de ejemplo · Vacante de ejemplo'
    }],
    outreachFilters: {
      city: 'Ciudad de ejemplo',
      vacancyId: 'vacancy-example-1'
    },
    outreachConfig: {
      templateName: 'citacion_entrevista_loginpro',
      templateLanguage: 'es_CO',
      interviewDate: '2026-08-28',
      interviewTime: '09:00',
      interviewAddress: 'Sede de ejemplo'
    },
    coordinatorContact: {
      apiPhone: '573000000000',
      displayPhone: '+57 300 000 0000'
    },
    templateReference: 'Hola {{1}}. Mensaje técnico de ejemplo.',
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

test('ADMIN no recibe detalles técnicos de la plantilla en el HTML', () => {
  const html = renderInterviewOutreach('admin');

  assert.doesNotMatch(html, /Plantilla oficial de Meta/);
  assert.doesNotMatch(html, /Nombre de plantilla/);
  assert.doesNotMatch(html, /Idioma Meta/);
  assert.doesNotMatch(html, /Quick Reply/);
  assert.doesNotMatch(html, /payloads/);
  assert.doesNotMatch(html, /InterviewBooking/);
  assert.doesNotMatch(html, /API oficial/);
  assert.doesNotMatch(html, /variable 5|variable 6/);
  assert.doesNotMatch(html, /Enviar citaciones por Meta/);
  assert.doesNotMatch(html, /Citaciones confirmadas por Meta/);
  assert.doesNotMatch(html, /name="templateName"|name="templateLanguage"/);
  assert.doesNotMatch(html, /citacion_entrevista_loginpro|es_CO/);

  assert.match(html, /<label for="interviewDate">Fecha de entrevista<\/label>/);
  assert.match(html, /<label for="interviewTime">Hora de entrevista<\/label>/);
  assert.match(html, /<label for="interviewAddress">Dirección de citación<\/label>/);
  assert.match(html, /<label for="coordinatorPhone">WhatsApp de coordinación<\/label>/);
  assert.match(html, />Enviar citaciones<\/button>/);
});

test('backend conserva la plantilla canónica cuando ADMIN no envía campos técnicos', () => {
  const config = normalizeInterviewOutreachConfig({
    interviewDate: '2026-08-28',
    interviewTime: '09:00',
    interviewAddress: 'Sede de ejemplo'
  });

  assert.equal(config.templateName, 'citacion_entrevista_loginpro');
  assert.equal(config.templateLanguage, 'es_CO');
});

test('DEV conserva controles y documentación técnica de la plantilla', () => {
  const html = renderInterviewOutreach('dev');

  assert.match(html, /Plantilla oficial de Meta/);
  assert.match(html, /Nombre de plantilla/);
  assert.match(html, /Idioma Meta/);
  assert.match(html, /Quick Reply/);
  assert.match(html, /payloads estables/);
  assert.match(html, /id="templateName" name="templateName" value="citacion_entrevista_loginpro"/);
  assert.match(html, /id="templateLanguage" name="templateLanguage" value="es_CO"/);
});

test('la mejora global se aplica a las respuestas HTML', () => {
  const source = readSource('src/registerGlobalFavicon.js');
  assert.match(source, /enhanceApprovedRecruitmentUx/);
  assert.match(source, /enhanceApprovedRecruitmentUx\(/);
});
