import express from 'express';

const PATCH_MARK = Symbol.for('lorren.adminDateRangeRelocatedToCvAnalysis');
const DATE_RANGE_SECTION_PATTERN = /\s*<section class="applicant-date-range"[\s\S]*?<\/section>/i;

function withoutDateRange(query = {}) {
  const sanitized = { ...query };
  delete sanitized.dateFrom;
  delete sanitized.dateTo;
  return sanitized;
}

function removeApplicantDateRangeControl(html) {
  return typeof html === 'string'
    ? html.replace(DATE_RANGE_SECTION_PATTERN, '')
    : html;
}

export function installAdminDateRangeRelocation() {
  if (express.response[PATCH_MARK]) return;

  const originalRender = express.response.render;
  express.response.render = function renderWithoutGeneralApplicantDateRange(view, options, callback) {
    if (view !== 'list' || !this.req) {
      return originalRender.call(this, view, options, callback);
    }

    const response = this;
    const originalQuery = response.req.query || {};
    response.req.query = withoutDateRange(originalQuery);

    const restoreQuery = () => {
      response.req.query = originalQuery;
    };

    try {
      return originalRender.call(response, view, options, (error, html) => {
        restoreQuery();
        if (error) {
          if (typeof callback === 'function') return callback(error);
          return response.status(500).send('No fue posible mostrar el listado de candidatos.');
        }

        const output = removeApplicantDateRangeControl(html);
        if (typeof callback === 'function') return callback(null, output);
        return response.send(output);
      });
    } catch (error) {
      restoreQuery();
      throw error;
    }
  };

  Object.defineProperty(express.response, PATCH_MARK, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
}

installAdminDateRangeRelocation();
