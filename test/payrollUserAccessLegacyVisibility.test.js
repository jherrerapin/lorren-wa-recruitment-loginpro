import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function legacyLabel() {
  const calls = [];
  return {
    hidden: false,
    style: {
      setProperty(...args) {
        calls.push(args);
      }
    },
    calls
  };
}

function legacyInput(label) {
  return {
    closest(selector) {
      return selector === 'label' ? label : null;
    }
  };
}

test('Usuarios oculta las raíces operativas legacy incluso frente a display !important', async () => {
  const source = await read('src/public/payroll-user-access.js');
  const dispatchLabel = legacyLabel();
  const attendanceLabel = legacyLabel();
  const inputs = new Map([
    ['input[name="canAccessDispatch"]', legacyInput(dispatchLabel)],
    ['input[name="canAccessAttendance"]', legacyInput(attendanceLabel)]
  ]);
  const form = {
    querySelector(selector) {
      return inputs.get(selector) || null;
    }
  };

  const document = {
    currentScript: { dataset: { operationalActorRole: 'none' } },
    readyState: 'complete',
    querySelector(selector) {
      return selector === 'form[action="/admin/users/create"]' ? form : null;
    },
    querySelectorAll() {
      return [];
    }
  };

  const context = vm.createContext({
    document,
    URLSearchParams,
    sessionStorage: {
      getItem() { return null; },
      removeItem() {},
      setItem() {}
    },
    window: { location: { search: '' } },
    fetch: async () => { throw new Error('unexpected_fetch'); },
    console
  });

  vm.runInContext(source, context, { filename: 'payroll-user-access.js' });

  for (const label of [dispatchLabel, attendanceLabel]) {
    assert.equal(label.hidden, true);
    assert.deepEqual(label.calls, [['display', 'none', 'important']]);
  }
});
