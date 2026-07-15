import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const branch = 'refactor/463-admin-interview-transition-authority';
const ciPath = '.github/workflows/ci.yml';
const temporaryWorkflowPath = '.github/workflows/apply-admin-interview-transition-authority.yml';
const selfPath = 'scripts/apply-admin-interview-transition-authority.mjs';

let ci = fs.readFileSync(ciPath, 'utf8').replaceAll('\r\n', '\n');
const start = ci.indexOf('  apply-admin-interview-transition-authority:');
const end = ci.indexOf('  state-authority:', start);
if (start < 0 || end < 0) {
  throw new Error(`temporary_ci_job_markers_invalid:${start}:${end}`);
}
ci = ci.slice(0, start) + ci.slice(end);

const oldGate = '        run: node --test test/interviewBookingStateService.test.js test/interviewSchedulerAuthority.test.js test/interviewLifecycle.test.js';
const newGate = `${oldGate} test/interviewBookingAdminStateService.test.js test/adminInterviewBookingAuthority.test.js`;
if (!ci.includes(oldGate)) {
  throw new Error('interview_authority_gate_marker_missing');
}
ci = ci.replace(oldGate, newGate);

if (ci.includes('apply-admin-interview-transition-authority:') || ci.includes('contents: write')) {
  throw new Error('temporary_ci_permissions_remain');
}
if (!ci.includes('test/interviewBookingAdminStateService.test.js') || !ci.includes('test/adminInterviewBookingAuthority.test.js')) {
  throw new Error('permanent_admin_tests_missing');
}

fs.writeFileSync(ciPath, ci, 'utf8');
fs.rmSync(temporaryWorkflowPath, { force: true });
fs.rmSync(selfPath, { force: true });

execFileSync('git', ['config', 'user.name', 'github-actions[bot]'], { stdio: 'inherit' });
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { stdio: 'inherit' });
execFileSync('git', ['add', ciPath, temporaryWorkflowPath, selfPath], { stdio: 'inherit' });
execFileSync('git', ['commit', '-m', 'ci: bloquear regresiones administrativas de entrevistas'], { stdio: 'inherit' });
execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' });

console.log('Temporary admin interview migration tooling removed.');
