from pathlib import Path

path = Path('src/routes/dispatchAssignmentConfirmations.js')
source = path.read_text(encoding='utf-8')
original = source

bad_selector = '${FINAL_ASSIGNMENT_CARD_SELECTOR} ${FINAL_ASSIGNMENT_CARD_SELECTOR} .whatsapp-link,'
good_selector = '${FINAL_ASSIGNMENT_CARD_SELECTOR} .whatsapp-link,'
if bad_selector not in source:
    raise SystemExit('No se encontró el selector duplicado que debe corregirse.')
source = source.replace(bad_selector, good_selector, 1)

source = source.replace(
    "  return cardHtml\n    .replace('<article class=\"assigned-card\"', '<article class=\"assigned-card assignment-final-card\"')\n    .replace(/<button[^>]*class=\"[^\"]*(?:whatsapp-link|dispatch-wa-button)[^\"]*\"[\\s\\S]*?<\\/button>/g, '')\n    ;",
    "  return cardHtml\n    .replace('<article class=\"assigned-card\"', '<article class=\"assigned-card assignment-final-card\"')\n    .replace(/<button[^>]*class=\"[^\"]*(?:whatsapp-link|dispatch-wa-button)[^\"]*\"[\\s\\S]*?<\\/button>/g, '');"
)

if '.assignment-message' in source:
    raise SystemExit('Todavía existe una referencia a assignment-message en dispatchAssignmentConfirmations.js.')
if bad_selector in source:
    raise SystemExit('El selector duplicado continúa presente.')
if source == original:
    raise SystemExit('No se aplicó ninguna corrección final.')

path.write_text(source, encoding='utf-8')
