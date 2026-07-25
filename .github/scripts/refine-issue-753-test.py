from pathlib import Path

path = Path('test/dispatchWhatsappLoadingAndTestClientAccess.test.js')
text = path.read_text(encoding='utf-8')
broken = "  assert.doesNotMatch(coreRoute, /isActive:[^\n]+isTestClient: normalizeString\\(req\\.body\\.isTestClient\\)/);"
corrected = r"  assert.doesNotMatch(coreRoute, /isActive: normalizeString\(req\.body\.isActive\) !== 'false', isTestClient:/);"
if broken not in text:
    raise SystemExit('No se encontró la expresión regular generada con salto de línea')
path.write_text(text.replace(broken, corrected, 1), encoding='utf-8')
