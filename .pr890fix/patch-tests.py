from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'Missing expected block: {label}')
    return text.replace(old, new, 1)


attachment_path = Path('test/attachmentAnalysisContract.test.js')
attachment = attachment_path.read_text(encoding='utf-8')

if 'let matchCalls = 0;' not in attachment:
    attachment = replace_once(
        attachment,
        """  const calls = [];
  const openAiPost = async (payload) => {""",
        """  const calls = [];
  let matchCalls = 0;
  const openAiPost = async (payload) => {""",
        'match call counter'
    )

retry_marker = """    const matchInput = JSON.parse(payload.input[1].content[0].text);
    const requestedIds = matchInput.candidates.map((candidate) => candidate.candidateId);
"""
retry_block = """    const matchInput = JSON.parse(payload.input[1].content[0].text);
    const requestedIds = matchInput.candidates.map((candidate) => candidate.candidateId);
    matchCalls += 1;
    if (matchCalls > 1 && requestedIds.length === 3) {
      return { data: { output: [{ content: [{ parsed: { results: [
        {
          candidateId: 'candidate-possible',
          level: 'POSSIBLE',
          score: 58,
          reasons: ['Tiene experiencia relacionada con bodega.'],
          evidence: ['Hoja de vida: seis meses apoyando bodega.', 'Registro: transporte público.'],
          gaps: ['Falta confirmar un año de experiencia.']
        },
        {
          candidateId: 'candidate-strong',
          level: 'STRONG',
          score: 92,
          reasons: ['Cumple experiencia y Excel.'],
          evidence: ['Hoja de vida: dos años manejando inventarios y Excel.', 'Registro: medio de transporte Moto.'],
          gaps: []
        },
        {
          candidateId: 'candidate-unmatched',
          level: 'LOW',
          score: 18,
          reasons: ['La experiencia disponible está en otro contexto laboral.'],
          evidence: ['Experiencia en atención al cliente.'],
          gaps: ['No se encontró experiencia equivalente en inventarios.']
        }
      ] } }] }] } };
    }
"""
if 'matchCalls > 1 && requestedIds.length === 3' not in attachment:
    attachment = replace_once(
        attachment,
        retry_marker,
        retry_block,
        'complete batch retry response'
    )

attachment_path.write_text(attachment, encoding='utf-8')

contracts_path = Path('test/cvIntelligenceReviewContracts.test.js')
contracts = contracts_path.read_text(encoding='utf-8')
contracts = replace_once(
    contracts,
    """  assert.equal(singleCandidateRequests.length, 4);
  assert.equal(result.stats.low, 3);
  assert.equal(result.stats.manual, 10);""",
    """  assert.equal(singleCandidateRequests.length, 2);
  assert.equal(result.stats.low, 1);
  assert.equal(result.stats.manual, 12);""",
    'strict invalid-batch expectations'
)
contracts_path.write_text(contracts, encoding='utf-8')
