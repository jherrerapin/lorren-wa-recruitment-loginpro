from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{pathname}: expected one match, found {count}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/public/worker-biometric-mobile.js',
    """    const samples = [];
    let consecutiveFront = 0;
    let latest = null;
    let activeDeadline = deadline;

    while (Date.now() < activeDeadline) {
""",
    """    const samples = [];
    let consecutiveFront = 0;
    let latest = null;
    let activeDeadline = deadline;
    let sampleGraceGranted = false;

    while (Date.now() < activeDeadline) {
"""
)

replace_once(
    'src/public/worker-biometric-mobile.js',
    """      if (samples.length > 0 && samples.length < samplesRequired) {
        activeDeadline = Math.max(activeDeadline, Date.now() + SAMPLE_COMPLETION_GRACE_MS);
      }
""",
    """      if (samples.length > 0 && samples.length < samplesRequired && !sampleGraceGranted) {
        sampleGraceGranted = true;
        activeDeadline = Math.max(activeDeadline, Date.now() + SAMPLE_COMPLETION_GRACE_MS);
      }
"""
)

replace_once(
    'test/workerBiometricMarkingReliabilityContracts.test.js',
    """  assert.match(mobile, /activeDeadline = Math\\.max\\(activeDeadline, Date\\.now\\(\\) \\+ SAMPLE_COMPLETION_GRACE_MS\\)/);
  assert.match(mobile, /scores\\.realScore < MIN_REAL_SCORE/);
""",
    """  assert.match(mobile, /let sampleGraceGranted = false/);
  assert.match(mobile, /samples\\.length < samplesRequired && !sampleGraceGranted/);
  assert.match(mobile, /sampleGraceGranted = true/);
  assert.match(mobile, /activeDeadline = Math\\.max\\(activeDeadline, Date\\.now\\(\\) \\+ SAMPLE_COMPLETION_GRACE_MS\\)/);
  assert.match(mobile, /scores\\.realScore < MIN_REAL_SCORE/);
"""
)
