import express from 'express';

const PATCH_MARK = Symbol.for('lorren.adminDateRangeRelocatedToCvAnalysis');
const DATE_RANGE_SECTION_PATTERN = /\s*<section class="applicant-date-range"[\s\S]*?<\/section>/i;

function removeApplicantDateRangeControl(html) {
  return typeof html === 'string'
    ? html.replace(DATE_RANGE_SECTION_PATTERN, '')
    : html;
}

export function installAdminDateRangeRelocation() {
  if (express.response[PATCH_MARK]) return;

  const originalRender = express.response.render;
  express.response.render = function renderWithoutDuplicateApplicantDateRange(view, options, callback) {
    if (view !== 'list' || !this.req) {
      return originalRender.call(this, view, options, callback);
    }

    const response = this;
    return originalRender.call(response, view, options, (error, html) => {
      if (error) {
        if (typeof callback === 'function') return callback(error);
        return response.status(500).send('No fue posible mostrar el listado de candidatos.');
      }

      const output = removeApplicantDateRangeControl(html);
      if (typeof callback === 'function') return callback(null, output);
      return response.send(output);
    });
  };

  Object.defineProperty(express.response, PATCH_MARK, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
}

installAdminDateRangeRelocation();