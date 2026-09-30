from pathlib import Path

path = Path('test/workerPortalAndroidCrewMemberProgressionRegression.test.js')
s = path.read_text()

old = "  assert.match(renderSource, /memberMarkType === 'ARRIVAL'[\\s\\S]{0,360}Marcar entrada/);\n"
new = "  assert.match(renderSource, /memberMarkType[\\s\\S]{0,260}status === 'PENDING'[\\s\\S]{0,320}markInfo\\(memberMarkType\\)\\.noun/);\n  assert.match(renderSource, /startManualMark\\(member, memberMarkType\\)/);\n  assert.match(renderSource, /markMemberManually\\(member, memberMarkType\\)/);\n"
if old not in s:
    raise SystemExit('stale ARRIVAL-only render assertion not found')
s = s.replace(old, new, 1)

old = """  const manualSource = sliceFunctionBlock(\n    nativePresence,\n    'async function startManualArrival(member)',\n    '\\n  function publicNativeError'\n  );\n  assert.match(manualSource, /bridgeCall\\('requestAttendanceLocation'/);\n  assert.match(manualSource, /MANUAL_ARRIVAL_PATH/);\n  assert.doesNotMatch(manualSource, /startCrewScan/);\n"""
new = """  const manualSource = sliceFunctionBlock(\n    nativePresence,\n    'async function startManualMark(member, markType)',\n    '\\n  function publicNativeError'\n  );\n  assert.match(manualSource, /bridgeCall\\('requestAttendanceLocation'/);\n  assert.match(manualSource, /markType: normalizedMark/);\n  assert.match(manualSource, /MANUAL_MARK_PATH/);\n  assert.doesNotMatch(manualSource, /startCrewScan/);\n"""
if old not in s:
    raise SystemExit('stale startManualArrival assertion block not found')
s = s.replace(old, new, 1)

old = """  const routeSource = sliceFunctionBlock(\n    route,\n    \"router.post('/cuadrillas/presencia/entrada-manual'\",\n    \"\\n  router.post('/cuadrillas/presencia/sincronizar'\"\n  );\n"""
new = """  const routeSource = sliceFunctionBlock(\n    route,\n    \"router.post('/cuadrillas/presencia/marca-manual'\",\n    \"\\n  router.post('/cuadrillas/presencia/sincronizar'\"\n  );\n"""
if old not in s:
    raise SystemExit('stale manual arrival route slice not found')
s = s.replace(old, new, 1)
s = s.replace("  assert.match(routeSource, /registerCrewPresenceArrivalFn/);\n", "  assert.match(routeSource, /registerCrewPresenceArrivalFn/);\n  assert.match(routeSource, /registerCrewPresenceMarkFn/);\n  assert.match(routeSource, /markType = normalizeBiometricMarkType/);\n", 1)

path.write_text(s)
