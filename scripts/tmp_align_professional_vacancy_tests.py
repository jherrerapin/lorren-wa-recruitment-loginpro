from pathlib import Path

p = Path('test/vacancyFirstGate.test.js')
t = p.read_text(encoding='utf-8')
old = "assert.match(decision.reply, /requisitos registrados/i);"
new = "assert.match(decision.reply, /Los requisitos para .* son:/i);"
count = t.count(old)
if count != 1:
    raise SystemExit(f'stale vacancy requirement assertion: expected 1 match, got {count}')
p.write_text(t.replace(old, new, 1), encoding='utf-8')
print('stale candidate-facing wording assertion aligned')
