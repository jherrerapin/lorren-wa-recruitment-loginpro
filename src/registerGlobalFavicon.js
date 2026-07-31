import express from 'express';
import { enhanceCvAnalysisExportSelection } from './services/cvAnalysisExportUi.js';
import { ensureGlobalFavicon } from './services/htmlFavicon.js';

const PATCH_MARK = Symbol.for('lorren.globalFaviconPatched');

if (!express.response[PATCH_MARK]) {
  const originalSend = express.response.send;

  Object.defineProperty(express.response, PATCH_MARK, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  express.response.send = function sendWithGlobalHtmlEnhancements(body) {
    const output = typeof body === 'string'
      ? enhanceCvAnalysisExportSelection(ensureGlobalFavicon(body))
      : body;
    return originalSend.call(this, output);
  };
}
