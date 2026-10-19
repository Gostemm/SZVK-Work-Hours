const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'trackers.html'), 'utf8');
function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Tracker Hub section must exist: ${start}`);
  return html.slice(from, to);
}

function deletionFixture(repairs) {
  const elements = new Map();
  const events = new Map();
  const calls = { history: [], save: 0, render: 0, stats: 0, toast: [] };
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        const listeners = new Map();
        const element = {
          isConnected: true,
          classList: {
            add: value => classes.add(value),
            remove: value => classes.delete(value),
            contains: value => classes.has(value)
          },
          addEventListener: (type, callback) => listeners.set(type, callback),
          dispatch: (type, event = {}) => listeners.get(type)?.({ target: element, ...event }),
          focus: () => { document.activeElement = element; },
          querySelectorAll: () => ['closeDeleteRepair', 'cancelDeleteRepair', 'confirmDeleteRepair'].map(id => document.getElementById(id))
        };
        elements.set(id, element);
      }
      return elements.get(id);
    },
    addEventListener: (type, callback) => events.set(type, callback)
  };
  const appData = { repairs };
  const trigger = document.getElementById('trashTrigger');
  trigger.focus();
  const context = vm.createContext({
    window: {}, document, appData,
    confirm: () => { throw new Error('Repair deletion must work without native browser dialogs'); },
    logAction: entry => calls.history.push(entry),
    saveLocalData: () => calls.save++,
    renderRepairs: () => calls.render++,
    updateDashboardStats: () => calls.stats++,
    showToast: message => calls.toast.push(message)
  });
  vm.runInContext(section("const deleteRepairModal = document.getElementById('deleteRepairModal');", 'window.deleteInventoryItem = function(id)'), context);
  return {
    context, appData, calls, document, trigger,
    element: id => document.getElementById(id),
    click: (id, event) => document.getElementById(id).dispatch('click', event),
    key: event => events.get('keydown')(event)
  };
}

test('the trash button opens an accessible confirmation without deleting the repair', () => {
  const repair = { id: 7, vehicle: 'TEST-7', carrier: 'Перевізник' };
  const fixture = deletionFixture([repair]);
  fixture.context.window.deleteRepair('7');
  assert.equal(fixture.element('deleteRepairModal').classList.contains('active'), true);
  assert.match(fixture.element('deleteRepairMessage').textContent, /TEST-7.*Перевізник/);
  assert.equal(fixture.document.activeElement, fixture.element('cancelDeleteRepair'));
  assert.equal(fixture.appData.repairs[0], repair);
  assert.equal(fixture.calls.history.length, 0);
  assert.equal(fixture.calls.save, 0);
});

test('cancel, close, backdrop and Escape preserve repairs and clear pending deletion', () => {
  for (const dismiss of [
    fixture => fixture.click('cancelDeleteRepair'),
    fixture => fixture.click('closeDeleteRepair'),
    fixture => fixture.click('deleteRepairModal'),
    fixture => fixture.key({ key: 'Escape', preventDefault() {} })
  ]) {
    const repair = { id: 'repair-7', vehicle: 'TEST-7' };
    const fixture = deletionFixture([repair]);
    fixture.context.window.deleteRepair(repair.id);
    dismiss(fixture);
    fixture.click('confirmDeleteRepair');
    assert.equal(fixture.element('deleteRepairModal').classList.contains('active'), false);
    assert.equal(fixture.appData.repairs[0], repair);
    assert.equal(fixture.calls.history.length, 0);
    assert.equal(fixture.calls.save, 0);
    assert.equal(fixture.document.activeElement, fixture.trigger);
  }
});

test('clicking inside the confirmation and tabbing through it do not dismiss it', () => {
  const fixture = deletionFixture([{ id: 7 }]);
  fixture.context.window.deleteRepair(7);
  fixture.click('deleteRepairModal', { target: fixture.element('deleteRepairMessage') });
  assert.equal(fixture.element('deleteRepairModal').classList.contains('active'), true);
  const first = fixture.element('closeDeleteRepair');
  const last = fixture.element('confirmDeleteRepair');
  let prevented = 0;
  last.focus();
  fixture.key({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ });
  assert.equal(fixture.document.activeElement, first);
  fixture.key({ key: 'Tab', shiftKey: true, preventDefault: () => prevented++ });
  assert.equal(fixture.document.activeElement, last);
  assert.equal(prevented, 2);
});

test('confirmation deletes numeric and text IDs once and records the actual repair for undo', () => {
  for (const [recordId, clickedId] of [[7, '7'], ['7', 7], ['repair-7', 'repair-7'], ['repair-\'7"<x>', 'repair-\'7"<x>']]) {
    const repair = { id: recordId, vehicle: 'TEST-7', serial: '0007', issue: 'GPS', extra: { preserved: true } };
    const other = { id: 'untouched', vehicle: 'TEST-8' };
    const fixture = deletionFixture([repair, other]);
    fixture.context.window.deleteRepair(clickedId);
    fixture.click('confirmDeleteRepair');
    fixture.click('confirmDeleteRepair');
    assert.equal(fixture.appData.repairs.length, 1);
    assert.equal(fixture.appData.repairs[0], other);
    assert.equal(fixture.calls.history.length, 1);
    assert.equal(fixture.calls.history[0].type, 'repair_delete');
    assert.equal(fixture.calls.history[0].restoreData.repair, repair);
    assert.deepEqual([fixture.calls.save, fixture.calls.render, fixture.calls.stats], [1, 1, 1]);
    assert.deepEqual(fixture.calls.toast, ['Запис видалено']);
    assert.equal(fixture.element('deleteRepairModal').classList.contains('active'), false);
    assert.equal(fixture.document.activeElement, fixture.trigger);
  }
});

test('confirmation uses the latest repair data when cloud updates arrive while the dialog is open', () => {
  const fixture = deletionFixture([{ id: 7, vehicle: 'OLD', solution: '' }]);
  fixture.context.window.deleteRepair('7');
  const updated = { id: '7', vehicle: 'LATEST', solution: 'Нові дані', specialist: 'Артем' };
  const remoteNew = { id: 8, vehicle: 'REMOTE' };
  fixture.appData.repairs = [updated, remoteNew];
  fixture.click('confirmDeleteRepair');
  assert.equal(fixture.appData.repairs.length, 1);
  assert.equal(fixture.appData.repairs[0], remoteNew);
  assert.equal(fixture.calls.history[0].restoreData.repair, updated);
  assert.match(fixture.calls.history[0].description, /LATEST/);
});

test('a repair deleted elsewhere closes confirmation without a duplicate deletion or history entry', () => {
  const fixture = deletionFixture([{ id: 7 }]);
  fixture.context.window.deleteRepair(7);
  fixture.appData.repairs = [];
  fixture.click('confirmDeleteRepair');
  assert.equal(fixture.element('deleteRepairModal').classList.contains('active'), false);
  assert.equal(fixture.calls.history.length, 0);
  assert.deepEqual([fixture.calls.save, fixture.calls.render, fixture.calls.stats], [0, 0, 0]);
  assert.deepEqual(fixture.calls.toast, ['Цей запис уже видалено']);
  fixture.click('confirmDeleteRepair');
  assert.equal(fixture.calls.toast.length, 1);
});

test('an unknown repair cannot open a deletion confirmation', () => {
  const fixture = deletionFixture([{ id: 7 }]);
  fixture.context.window.deleteRepair('unknown');
  assert.equal(fixture.element('deleteRepairModal').classList.contains('active'), false);
  fixture.click('confirmDeleteRepair');
  assert.equal(fixture.appData.repairs.length, 1);
  assert.equal(fixture.calls.save, 0);
});

test('delegated repair controls use current handlers and the clicked row ID in either journal', () => {
  const tables = [0, 1].map(() => ({
    addEventListener(type, handler) { assert.equal(type, 'click'); this.click = handler; },
    contains: button => button.inside !== false
  }));
  const window = {};
  const calls = [];
  const source = section("document.querySelectorAll('[data-repair-table]').forEach(table => {\n    table.addEventListener('click'", "document.getElementById('repairArchive').addEventListener('toggle'");
  vm.runInNewContext(source, {
    window,
    document: { querySelectorAll: selector => { assert.equal(selector, '[data-repair-table]'); return tables; } }
  });
  for (const table of tables) {
    for (const action of ['edit', 'duplicate', 'finish', 'delete']) {
      const id = `repair-'7"/${action}`;
      window[`${action}Repair`] = currentId => calls.push([action, currentId]);
      const button = { dataset: { repairAction: action }, closest: () => ({ dataset: { repairId: id } }) };
      table.click({ target: { closest: () => button } });
      assert.deepEqual(calls.at(-1), [action, id]);
    }
  }
  const callCount = calls.length;
  tables[0].click({ target: { closest: () => null } });
  tables[0].click({ target: { closest: () => ({ inside: false }) } });
  tables[0].click({ target: { closest: () => ({ dataset: { repairAction: 'delete' }, closest: () => null }) } });
  assert.equal(calls.length, callCount);
});

test('pending repairs place the completion control across all three result columns', () => {
  const context = vm.createContext({
    window: { location: { search: '' }, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null },
    document: { documentElement: { setAttribute() {} } },
    URLSearchParams, Date
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), context);
  const shared = context.window.SZVKShared;
  Object.assign(context, {
    escapeHtml: value => shared.escapeHtml(value, '&#39;'),
    isRepairPending: shared.isRepairPending,
    getCarrierClass: () => 'carrier-test',
    getTechBadgeHtml: value => shared.escapeHtml(value),
    formatSerialHtml: value => shared.escapeHtml(value),
    formatNotesHtml: value => shared.escapeHtml(value)
  });
  vm.runInContext(section('function buildRepairRow(item) {', 'function renderRepairRows('), context);
  const repair = { id: 'repair-\'7"<x>', date: '19.10.2026', vehicle: 'TEST-7' };
  const pending = context.buildRepairRow(repair);
  assert.match(pending, /<td colspan="3" class="repair-result-cell">[\s\S]*data-repair-action="finish"[\s\S]*<\/td>/);
  assert.match(pending, /Звітувати про завершення ремонту/);
  assert.equal((pending.match(/<td(?:\s|>)/g) || []).length, 8);
  assert.match(pending, /data-repair-id="repair-&#39;7&quot;&lt;x&gt;"/);
  assert.doesNotMatch(pending, /\bonclick=/);
  for (const action of ['edit', 'duplicate', 'delete']) assert.ok(pending.includes(`data-repair-action="${action}"`));

  const completed = context.buildRepairRow({ ...repair, repairDate: '19.10.2026', specialist: 'Артем', solution: 'Виконано' });
  assert.doesNotMatch(completed, /colspan="3"|data-repair-action="finish"/);
  assert.equal((completed.match(/<td(?:\s|>)/g) || []).length, 10);
  assert.match(completed, /repair-date-label[\s\S]*19\.10\.2026/);
  assert.match(completed, /Артем/);
});
