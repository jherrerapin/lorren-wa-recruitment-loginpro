import fs from 'node:fs';
import assert from 'node:assert/strict';

const path = 'src/routes/admin.js';
let source = fs.readFileSync(path, 'utf8');
const before = `    res.render('detail', {
      candidate: detailCandidate, role: req.userRole, formatDateTimeCO,
      canManageUsers: canManageRecruiterUsers(req),`;
const after = `    res.render('detail', {
      candidate: detailCandidate, role: req.userRole, formatDateTimeCO,
      canAccessDispatch: Boolean(req.canAccessDispatch),
      canManageUsers: canManageRecruiterUsers(req),`;

if (!source.includes(after)) {
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `render detail: se esperaba una coincidencia y se encontraron ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

console.log('Local canAccessDispatch agregado al detalle administrativo.');
