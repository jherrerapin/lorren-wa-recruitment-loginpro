from pathlib import Path

for filename in (
    'src/services/dispatchWhatsappWebServiceV6.js',
    'src/routes/dispatchWaRouterV2.js',
    'test/dispatchWhatsappRuntimeContracts.test.js',
):
    path = Path(filename)
    path.write_text(path.read_text(encoding='utf-8').rstrip() + '\n', encoding='utf-8')
