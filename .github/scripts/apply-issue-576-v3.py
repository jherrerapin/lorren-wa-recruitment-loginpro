from pathlib import Path

# Ejecuta la receta funcional y los contratos añadidos.
exec(compile(Path('.github/scripts/apply-issue-576-v2.py').read_text(encoding='utf-8'), '.github/scripts/apply-issue-576-v2.py', 'exec'), {})

path = Path('test/dispatchWhatsappRuntimeContracts.test.js')
content = path.read_text(encoding='utf-8')
start_marker = "test('watchdog recovers a stalled Chromium initialization without logging out the WhatsApp account'"
end_marker = "test('manual WhatsApp logout is respected by the server watchdog'"
start = content.find(start_marker)
end = content.find(end_marker, start + len(start_marker))
if start < 0 or end < 0:
    raise SystemExit(f'No se encontró el contrato watchdog: start={start} end={end}')
block = content[start:end]
declaration = """  const watchdog = between(
    source,
    "async function runDispatchWhatsappWatchdog(reason = 'interval')",
    'export function startDispatchWhatsappWatchdog()'
  );
"""
if 'const watchdog = between(' not in block:
    anchor = "  const source = readSource('src/services/dispatchWhatsappWebService.js');\n"
    if block.count(anchor) != 1:
        raise SystemExit('No se encontró el punto de inserción del contrato watchdog.')
    block = block.replace(anchor, anchor + declaration, 1)
    content = content[:start] + block + content[end:]
path.write_text(content, encoding='utf-8')
