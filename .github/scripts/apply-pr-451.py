from pathlib import Path
import re

admin_path = Path('src/routes/admin.js')
admin = admin_path.read_text(encoding='utf-8')

if 'deleteConversationMessagesByCandidate' not in admin:
    admin, import_count = re.subn(
        r"import \{ persistOutboundConversationMessage \} from '../services/conversationMessageRepository\.js';",
        "import {\n  deleteConversationMessagesByCandidate,\n  persistOutboundConversationMessage\n} from '../services/conversationMessageRepository.js';",
        admin,
        count=1
    )
    if import_count != 1:
        raise SystemExit(f'admin repository import replacements={import_count}')

admin, delete_count = re.subn(
    r"await\s+tx\.message\.deleteMany\(\{\s*where:\s*\{\s*candidateId:\s*candidate\.id\s*\}\s*\}\);",
    "await deleteConversationMessagesByCandidate(tx, {\n        candidateId: candidate.id\n      });",
    admin,
    count=1
)
if delete_count not in (0, 1):
    raise SystemExit(f'admin Message deletion replacements={delete_count}')
if delete_count == 0 and 'deleteConversationMessagesByCandidate(tx' not in admin:
    raise SystemExit('canonical candidate Message deletion was not found')
admin_path.write_text(admin, encoding='utf-8')

ci_path = Path('.github/workflows/ci.yml')
ci = ci_path.read_text(encoding='utf-8')
final_gate = '        run: node --test test/adminManualOutbound.test.js test/adminCandidateDeletionMessageAuthority.test.js\n'
if final_gate not in ci:
    ci, gate_count = re.subn(
        r"^        run: node --test test/adminManualOutbound\.test\.js$",
        final_gate.rstrip('\n'),
        ci,
        count=1,
        flags=re.MULTILINE
    )
    if gate_count != 1:
        raise SystemExit(f'admin CI gate replacements={gate_count}')

ci, job_count = re.subn(
    r"(?ms)^  apply-canonical-message-lifecycle:\n.*?(?=^  state-authority:\n)",
    '',
    ci,
    count=1
)
if job_count not in (0, 1):
    raise SystemExit(f'temporary CI job removals={job_count}')
ci_path.write_text(ci, encoding='utf-8')

Path('.github/workflows/apply-451.yml').unlink(missing_ok=True)
Path('.github/scripts/apply-pr-451.py').unlink(missing_ok=True)

print(f'admin_delete_replacements={delete_count}')
print(f'temporary_ci_job_removals={job_count}')
