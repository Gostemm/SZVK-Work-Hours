const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'shared.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(seed, remote = seed) {
  const storage = new Map([['szvk_schedule_local_data', JSON.stringify(seed)]]);
  const events = new Map();
  const context = vm.createContext({
    window: {
      location: { search: '' }, matchMedia: () => ({ matches: false }), setInterval() {},
      addEventListener(name, listener) { events.set(name, listener); }
    },
    document: { documentElement: { setAttribute() {} }, addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    URLSearchParams, Date
  });
  vm.runInContext(source, context);
  const cloud = copy(remote);
  let snapshotListener;
  let offline = false;
  let writes = 0;
  const doc = { onSnapshot(callback) { snapshotListener = callback; } };
  const db = {
    async runTransaction(callback) {
      if (offline) throw new Error('offline');
      let staged;
      const result = await callback({
        async get() { return { exists: true, data: () => copy(cloud) }; },
        set(ref, patch, options) {
          assert.equal(ref, doc);
          assert.deepEqual(copy(options), { mergeFields: ['dayNotes', 'updatedAt'] });
          staged = copy(patch);
        }
      });
      Object.assign(cloud, staged);
      writes++;
      return result;
    }
  };
  const shared = context.window.SZVKShared;
  let errors = 0;
  const createStore = () => shared.createScheduleTaskStore({ db, scheduleDoc: doc, onChange() {}, onError() { errors++; } });
  return { shared, cloud, storage, createStore, db, doc, setOffline(value) { offline = value; },
    snapshot(data) { snapshotListener({ exists: true, data: () => copy(data) }); },
    get errors() { return errors; }, get writes() { return writes; } };
}

const seed = () => ({
  dayNotes: { '2099-01-04': [{ id: 7, text: 'Original', time: '08:15', done: false, author: 'Operator', extra: 'keep' }] },
  overrides: { '2099-01-04': 'Артем' }, monthlyDebts: { '2099-01': 'keep monthly note' }
});

test('repair notes open a report before completion and show an automatic read-only check after completion', () => {
  const { shared } = fixture(seed());
  const pending = shared.repairTaskControlHtml({ repairId: 'legacy-"<&', text: 'Bus <7>', done: false }, '2099-01-06');
  assert.ok(pending.includes('finishRepair=legacy-%22%3C%26&taskDate=2099-01-06'));
  assert.ok(pending.includes('Bus &lt;7&gt;'));
  assert.ok(pending.includes('Звіт'));
  assert.ok(!pending.includes('type="checkbox"'));
  const completed = shared.repairTaskControlHtml({ repairId: 7, text: 'Bus', done: true }, '2099-01-06');
  assert.ok(completed.includes('checked disabled'));
  assert.ok(!completed.includes('finishRepair='));
  assert.equal(shared.repairTaskHref(7), 'trackers.html?editRepair=7');
  assert.equal(shared.repairTaskHref(7, true, 'invalid'), 'trackers.html?finishRepair=7');
});

test('Tracker Hub saves only the edited task against fresh cloud data, retaining concurrent tasks and schedule fields', async () => {
  const remote = seed();
  remote.dayNotes['2099-01-04'][0].done = true;
  remote.dayNotes['2099-01-04'].push({ id: 'concurrent', text: 'Added elsewhere', done: false });
  remote.overrides['2099-01-04'] = 'Олександр';
  remote.monthFocusNotes = { '2099-01': 'Fresh focus' };
  const f = fixture(seed(), remote);
  const store = f.createStore();
  const change = { kind: 'edit', taskId: 7, text: 'Edited', time: '16:45', targetDateKey: '2099-02-01' };
  f.shared.applyScheduleTaskChange(store.getData().dayNotes, change);
  await store.save(change);
  assert.deepEqual(f.cloud.dayNotes['2099-02-01'][0], { id: 7, text: 'Edited', time: '16:45', done: true, author: 'Operator', extra: 'keep' });
  assert.equal(f.cloud.dayNotes['2099-01-04'][0].id, 'concurrent');
  assert.deepEqual(f.cloud.overrides, remote.overrides);
  assert.deepEqual(f.cloud.monthFocusNotes, remote.monthFocusNotes);
  assert.deepEqual(f.cloud.monthlyDebts, remote.monthlyDebts);
  assert.equal(f.writes, 1);
});

test('offline edits survive stale snapshots and a reload, then retry without losing the new day or time', async () => {
  const f = fixture(seed());
  const store = f.createStore();
  f.setOffline(true);
  const change = { kind: 'edit', taskId: 7, text: 'Offline edit', time: '', targetDateKey: '2099-03-01' };
  f.shared.applyScheduleTaskChange(store.getData().dayNotes, change);
  await store.save(change);
  assert.equal(f.errors, 1);
  f.snapshot(seed());
  assert.equal(store.getData().dayNotes['2099-03-01'][0].text, 'Offline edit');
  const reloaded = f.createStore();
  assert.equal(reloaded.getData().dayNotes['2099-03-01'][0].time, undefined);
  f.setOffline(false);
  await reloaded.save({ kind: 'done', taskId: 7, done: true });
  assert.equal(f.cloud.dayNotes['2099-03-01'][0].text, 'Offline edit');
  assert.equal(f.cloud.dayNotes['2099-03-01'][0].done, true);
  assert.equal(f.cloud.dayNotes['2099-03-01'][0].time, undefined);
  assert.deepEqual(JSON.parse(f.storage.get('szvk_pending_schedule_tasks')), []);
});

test('replayed task changes follow rollover by ID and never recreate tasks deleted elsewhere', () => {
  const f = fixture(seed());
  const notes = { '2099-02-01': [{ ...seed().dayNotes['2099-01-04'][0], carriedFrom: '2099-01-04' }] };
  assert.equal(f.shared.applyScheduleTaskChange(notes, { kind: 'done', taskId: '7', done: true }), true);
  assert.equal(notes['2099-02-01'][0].done, true);
  assert.equal(notes['2099-02-01'][0].carriedFrom, '2099-01-04');
  const before = copy(notes);
  assert.equal(f.shared.applyScheduleTaskChange(notes, { kind: 'edit', taskId: 'deleted', text: 'Do not recreate', time: '', targetDateKey: '2099-03-01' }), false);
  assert.deepEqual(notes, before);
});

test('Work Hours can display and flush edits queued offline in Tracker Hub after switching modules', async () => {
  const f = fixture(seed());
  const store = f.createStore();
  f.setOffline(true);
  const change = { kind: 'edit', taskId: 7, text: 'Saved in Tracker Hub', time: '17:30', targetDateKey: '2099-01-06' };
  f.shared.applyScheduleTaskChange(store.getData().dayNotes, change);
  await store.save(change);
  const incomingSchedule = seed();
  f.shared.applyPendingScheduleTaskChanges(incomingSchedule.dayNotes);
  assert.equal(incomingSchedule.dayNotes['2099-01-06'][0].text, 'Saved in Tracker Hub');
  f.setOffline(false);
  await f.shared.flushScheduleTaskChanges(f.db, f.doc);
  assert.equal(f.cloud.dayNotes['2099-01-06'][0].time, '17:30');
  assert.deepEqual(JSON.parse(f.storage.get('szvk_pending_schedule_tasks')), []);
});

test('manual note deletion preserves undo data and cannot delete linked repair notes', () => {
  const { shared } = fixture(seed());
  const notes = seed().dayNotes;
  const original = copy(notes['2099-01-04'][0]);
  assert.deepEqual(copy(shared.deleteManualTask(notes, '2099-01-04', '7')), original);
  assert.equal(notes['2099-01-04'], undefined, 'empty day buckets are removed');
  assert.equal(shared.deleteManualTask(notes, '2099-01-04', 7), null, 'deleting twice is harmless');
  notes['2099-01-04'] = [{ id: 'repair-9', repairId: 9, text: 'Linked repair', done: false }];
  const before = copy(notes);
  assert.equal(shared.deleteManualTask(notes, '2099-01-04', 'repair-9'), null);
  assert.equal(shared.applyScheduleTaskChange(notes, { kind: 'delete', taskId: 'repair-9' }), false);
  assert.deepEqual(notes, before);
});

test('offline deletion survives stale snapshots and removes the moved cloud note without losing concurrent tasks', async () => {
  const remote = seed();
  remote.dayNotes['2099-02-01'] = remote.dayNotes['2099-01-04'];
  remote.dayNotes['2099-01-04'] = [{ id: 'concurrent', text: 'Added elsewhere', done: false }];
  const f = fixture(seed(), remote);
  const store = f.createStore();
  f.setOffline(true);
  f.shared.deleteManualTask(store.getData().dayNotes, '2099-01-04', 7);
  await store.save({ kind: 'delete', taskId: 7, dateKey: '2099-01-04' });
  f.snapshot(remote);
  assert.equal(Object.values(store.getData().dayNotes).flat().some(task => task.id === 7), false);
  assert.equal(JSON.parse(f.storage.get('szvk_pending_schedule_tasks')).length, 1);
  f.setOffline(false);
  await f.shared.flushScheduleTaskChanges(f.db, f.doc);
  assert.equal(f.cloud.dayNotes['2099-02-01'], undefined);
  assert.equal(f.cloud.dayNotes['2099-01-04'][0].id, 'concurrent');
  assert.deepEqual(f.cloud.overrides, remote.overrides);
  assert.deepEqual(f.cloud.monthlyDebts, remote.monthlyDebts);
  assert.deepEqual(JSON.parse(f.storage.get('szvk_pending_schedule_tasks')), []);
});
