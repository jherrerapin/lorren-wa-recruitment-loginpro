from pathlib import Path
import re

schema_path = Path('prisma/schema.prisma')
schema = schema_path.read_text()
old_event = '''model CandidateAdminEvent {
  id          String    @id @default(cuid())
  candidateId String
  candidate   Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  actorRole   String
  eventType   String
  eventLabel  String
  fromValue   String?
  toValue     String?
  note        String?
  createdAt   DateTime  @default(now())

  @@index([candidateId, createdAt])
}
'''
new_event = '''model CandidateAdminEvent {
  id          String    @id @default(cuid())
  candidateId String
  candidate   Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  actorUserId String?
  actorUser   AppUser?  @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
  actorRole   String
  eventType   String
  eventLabel  String
  fromValue   String?
  toValue     String?
  note        String?
  createdAt   DateTime  @default(now())

  @@index([candidateId, createdAt])
  @@index([actorUserId])
}
'''
assert old_event in schema, 'CandidateAdminEvent schema block not found'
schema = schema.replace(old_event, new_event, 1)
app_user_anchor = '  vacancies           Vacancy[]       @relation("AppUserVacancies")\n'
assert app_user_anchor in schema, 'AppUser relation anchor not found'
schema = schema.replace(app_user_anchor, app_user_anchor + '  candidateAdminEvents CandidateAdminEvent[]\n', 1)
schema_path.write_text(schema)

migration = Path('prisma/migrations/20260902140500_add_candidate_admin_event_actor_user/migration.sql')
migration.parent.mkdir(parents=True, exist_ok=True)
migration.write_text('''ALTER TABLE "CandidateAdminEvent"
ADD COLUMN "actorUserId" TEXT;

CREATE INDEX "CandidateAdminEvent_actorUserId_idx"
ON "CandidateAdminEvent"("actorUserId");

ALTER TABLE "CandidateAdminEvent"
ADD CONSTRAINT "CandidateAdminEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "AppUser"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
''')

admin_path = Path('src/routes/admin.js')
admin = admin_path.read_text()
helper_sig = '''async function logCandidateAdminEvent(prisma, {
  candidateId,
  actorRole,
'''
assert helper_sig in admin, 'candidate audit helper signature not found'
admin = admin.replace(helper_sig, '''async function logCandidateAdminEvent(prisma, {
  candidateId,
  actorUserId = null,
  actorRole,
''', 1)

helper_start = admin.index('async function logCandidateAdminEvent')
helper_end = admin.index('\n}\n', helper_start) + 3
helper_block = admin[helper_start:helper_end]
helper_data = '''      data: {
        candidateId,
        actorRole: normalizeString(actorRole) || 'system',
'''
assert helper_data in helper_block, 'candidate audit helper data not found'
helper_block = helper_block.replace(helper_data, '''      data: {
        candidateId,
        actorUserId: normalizeString(actorUserId),
        actorRole: normalizeString(actorRole) || 'system',
''', 1)
admin = admin[:helper_start] + helper_block + admin[helper_end:]

handoff_actor = "  const actorRole = normalizeString(input.actorRole) || 'system';\n"
assert handoff_actor in admin, 'handoff actor role not found'
admin = admin.replace(handoff_actor, "  const actorUserId = normalizeString(input.actorUserId);\n" + handoff_actor, 1)

handoff_create = '''      candidateId,
      actorRole,
      eventType: 'STATUS_CHANGED',
      eventLabel: 'Citacion de entrevista enviada por Meta',
'''
assert handoff_create in admin, 'handoff audit create not found'
admin = admin.replace(handoff_create, '''      candidateId,
      actorUserId,
      actorRole,
      eventType: 'STATUS_CHANGED',
      eventLabel: 'Citacion de entrevista enviada por Meta',
''', 1)

handoff_call = '''              candidateId: context.candidateId,
              actorRole: req.userRole,
              sentAt: context.sentAt
'''
assert handoff_call in admin, 'handoff caller not found'
admin = admin.replace(handoff_call, '''              candidateId: context.candidateId,
              actorUserId: req.userId || null,
              actorRole: req.userRole,
              sentAt: context.sentAt
''', 1)

pattern = re.compile(r"(await logCandidateAdminEvent\(prisma, \{\n(?P<indent>\s+)candidateId: [^\n]+,\n)(?P=indent)actorRole: req\.userRole,")
def add_actor(match):
    indent = match.group('indent')
    return match.group(1) + f"{indent}actorUserId: req.userId || null,\n{indent}actorRole: req.userRole,"
admin, count = pattern.subn(add_actor, admin)
assert count == 11, f'expected 11 request audit callers, found {count}'

read_block = '''      ? await prisma.candidateAdminEvent.findMany({
        where: { candidateId: candidate.id },
        orderBy: { createdAt: 'desc' },
        take: 30
      })
'''
assert read_block in admin, 'admin event read block not found'
admin = admin.replace(read_block, '''      ? await prisma.candidateAdminEvent.findMany({
        where: { candidateId: candidate.id },
        include: {
          actorUser: {
            select: { displayName: true, username: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 30
      })
''', 1)
admin_path.write_text(admin)

view_path = Path('src/views/detail.ejs')
view = view_path.read_text()
actor_line = '            <% const actorLabel = formatActorRoleLabel(event.actorRole); %>\n'
assert actor_line in view, 'detail actor label not found'
view_path.write_text(view.replace(actor_line, '''            <% const actorLabel = String(event.actorUser?.displayName || '').trim()
              || String(event.actorUser?.username || '').trim()
              || formatActorRoleLabel(event.actorRole); %>
''', 1))

test_path = Path('test/adminManualCv.test.js')
test = test_path.read_text()
vacancy_mock = '''    vacancy: {
      async findMany() {
        return [];
      }
    },
    candidateAdminEvent: {
'''
assert vacancy_mock in test, 'test vacancy mock anchor not found'
test = test.replace(vacancy_mock, '''    vacancy: {
      async findMany() {
        return [];
      }
    },
    appUser: {
      async findMany() {
        return [];
      },
      async findUnique({ where } = {}) {
        const id = where?.id || null;
        const username = where?.username || (id === 'user-dev-fixture' ? 'dev-fixture' : 'reclutador-fixture');
        if (!id && !where?.username) return null;
        return {
          id: id || `user-${username}`,
          username,
          displayName: id === 'user-dev-fixture' ? 'Usuario Dev Prueba' : 'Usuario Reclutador Prueba',
          email: null,
          recoveryPhone: null,
          dispatchAlertPhone: null,
          role: id === 'user-dev-fixture' ? 'DEV' : 'ADMIN',
          isActive: true
        };
      }
    },
    candidateAdminEvent: {
''', 1)

session_line = "    sessions.set(sid, { userRole: req.params.role });\n"
assert session_line in test, 'test login session anchor not found'
test = test.replace(session_line, '''    sessions.set(sid, {
      userRole: req.params.role,
      userId: `user-${req.params.role}-fixture`,
      username: `${req.params.role}-fixture`
    });
''', 1)

status_assert = "    assert.equal(prisma.state.candidateAdminEvents[0].actorRole, 'admin');\n"
assert status_assert in test, 'status actor role assertion not found'
test = test.replace(status_assert, status_assert + "    assert.equal(prisma.state.candidateAdminEvents[0].actorUserId, 'user-admin-fixture');\n", 1)

named_event_anchor = '''        actorRole: 'admin',
        eventType: 'STATUS_CHANGED',
        eventLabel: 'Cambio de estado',
'''
assert named_event_anchor in test, 'movement event anchor not found'
test = test.replace(named_event_anchor, '''        actorRole: 'admin',
        actorUser: {
          displayName: 'Usuario Prueba Norte',
          username: 'reclutador-prueba-norte'
        },
        eventType: 'STATUS_CHANGED',
        eventLabel: 'Cambio de estado',
''', 1)

event_tail = '''        createdAt: new Date('2026-04-08T15:12:00.000Z')
      }
    ]
'''
assert event_tail in test, 'movement event tail not found'
test = test.replace(event_tail, '''        createdAt: new Date('2026-04-08T15:12:00.000Z')
      },
      {
        id: 'event-2',
        actorRole: 'admin',
        eventType: 'WHATSAPP_OPENED',
        eventLabel: 'Apertura histórica',
        createdAt: new Date('2026-04-08T15:11:00.000Z')
      },
      {
        id: 'event-3',
        actorRole: 'admin',
        actorUser: {
          displayName: null,
          username: 'usuario-prueba-centro'
        },
        eventType: 'STATUS_CHANGED',
        eventLabel: 'Movimiento con usuario',
        createdAt: new Date('2026-04-08T15:10:00.000Z')
      }
    ]
''', 1)

movement_asserts = '''    assert.match(devHtml, /Cambio de estado/);
    assert.match(devHtml, /Reclutador/);
    assert.match(devHtml, /Registrado/);
'''
assert movement_asserts in test, 'movement assertions not found'
test = test.replace(movement_asserts, '''    assert.match(devHtml, /Cambio de estado/);
    assert.match(devHtml, /Por:\\s*Usuario Prueba Norte/);
    assert.match(devHtml, /Apertura histórica/);
    assert.match(devHtml, /Por:\\s*Reclutador/);
    assert.match(devHtml, /Movimiento con usuario/);
    assert.match(devHtml, /Por:\\s*usuario-prueba-centro/);
    assert.match(devHtml, /Registrado/);
''', 1)
test_path.write_text(test)
