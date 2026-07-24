import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

mkdirSync('diagnostics', { recursive: true });
const targetCommit = '2fb996b86e95c5e273c7a8f69b15d93d34ac42b5';
const treeSha = git(['rev-parse', `${targetCommit}^{tree}`]);
writeFileSync('diagnostics/631-harness-summary.txt', `target_commit=${targetCommit}\ntree_sha=${treeSha}\n`);
writeFileSync('diagnostics/631-remaining-failures.txt', 'TREE_SHA_READY\n');
writeFileSync('diagnostics/631-harness.tap', `tree_sha=${treeSha}\n`);
throw new Error('TREE_SHA_READY');
