from pathlib import Path

p = Path('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
text = p.read_text()
old = '        cancelAuxiliaryExchangeTimeout();\n        cancelAuxiliaryDiscoverabilityRefresh();\n        cancelLeaderTimeouts();\n'
new = '        cancelAuxiliaryExchangeTimeout();\n        cancelLeaderTimeouts();\n'
if old not in text:
    raise SystemExit('stale discoverability cleanup call not found')
p.write_text(text.replace(old, new, 1))
Path(__file__).unlink()
