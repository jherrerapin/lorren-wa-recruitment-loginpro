import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const immutablePatchUrl = 'https://raw.githubusercontent.com/jherrerapin/lorren-wa-recruitment-loginpro/dbc29bac87d12b6b1e3266379cc65a9912afd113/scripts/apply-506-candidate-multiline-authority.mjs';
const response = await fetch(immutablePatchUrl);
if (!response.ok) {
  throw new Error(`issue_506_patch_download_failed:${response.status}`);
}

let source = await response.text();
const ciStartMarker = "const ciPath = '.github/workflows/ci.yml';";
const testsStartMarker = "write('test/candidateMultilineStateService.test.js'";
const ciStart = source.indexOf(ciStartMarker);
const testsStart = source.indexOf(testsStartMarker, ciStart + ciStartMarker.length);
if (ciStart === -1 || testsStart === -1 || testsStart <= ciStart) {
  throw new Error('issue_506_ci_patch_section_not_found');
}
source = source.slice(0, ciStart) + source.slice(testsStart);

const temporaryPatchPath = path.join(os.tmpdir(), 'apply-506-candidate-multiline-authority.mjs');
fs.writeFileSync(temporaryPatchPath, source);
await import(pathToFileURL(temporaryPatchPath).href);
