import fs from 'node:fs';
import assert from 'node:assert/strict';

const path = 'src/routes/admin.js';
let source = fs.readFileSync(path, 'utf8');

const legacyBefore = `        mode: 'legacy', candidates, formatDateTimeCO, role: req.userRole,
        canManageUsers: canManageRecruiterUsers(req),`;
const legacyAfter = `        mode: 'legacy', candidates, formatDateTimeCO, role: req.userRole,
        canAccessDispatch: Boolean(req.canAccessDispatch),
        canManageUsers: canManageRecruiterUsers(req),`;

const dashboardBefore = `      todayStr: todayCO(), formatDateTimeCO, formatTimeCO, role: req.userRole,
      canManageUsers: canManageRecruiterUsers(req),`;
const dashboardAfter = `      todayStr: todayCO(), formatDateTimeCO, formatTimeCO, role: req.userRole,
      canAccessDispatch: Boolean(req.canAccessDispatch),
      canManageUsers: canManageRecruiterUsers(req),`;

for (const [label, before, after] of [
  ['legacy render', legacyBefore, legacyAfter],
  ['vacancy render', dashboardBefore, dashboardAfter]
]) {
  if (source.includes(after)) continue;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  source = source.replace(before, after);
}

fs.writeFileSync(path, source);
console.log('Contrato canAccessDispatch aplicado en ambos renders de /admin.');
