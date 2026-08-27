const APPROVED_OUTREACH_PREPARE_ACTION = '/admin/outreach/approved/prepare';
const APPROVED_OUTREACH_WINDOW_SCRIPT = '/public/approved-outreach-window.js';

export function ensureApprovedOutreachWindowUi(html) {
  if (typeof html !== 'string') return html;
  if (!html.includes(APPROVED_OUTREACH_PREPARE_ACTION)) return html;
  if (html.includes(`src="${APPROVED_OUTREACH_WINDOW_SCRIPT}"`)) return html;
  if (!/<\/body>/i.test(html)) return html;

  return html.replace(
    /<\/body>/i,
    `  <script src="${APPROVED_OUTREACH_WINDOW_SCRIPT}"></script>\n</body>`
  );
}
