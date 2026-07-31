export const GLOBAL_FAVICON_HREF = '/public/favicon-loginpro.svg?v=20260731';

const ICON_LINK_PATTERN = /[ \t]*<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>\s*\n?/gi;

export function ensureGlobalFavicon(html) {
  if (typeof html !== 'string' || !/<head\b[^>]*>/i.test(html) || !/<\/head>/i.test(html)) {
    return html;
  }

  const faviconTag = `<link rel="icon" type="image/svg+xml" href="${GLOBAL_FAVICON_HREF}">`;
  const withoutExistingIcons = html.replace(ICON_LINK_PATTERN, '');
  return withoutExistingIcons.replace(/<head\b[^>]*>/i, (headTag) => `${headTag}\n  ${faviconTag}`);
}
