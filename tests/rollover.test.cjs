const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'shared.js'), 'utf8');
const indexHtml = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function loadShared(DateClass = Date) {
  const storage = new Map();
  const context = vm.createContext({
    window: { location: { search: '' }, matchMedia: () => ({ matches: false }) },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: { documentElement: { setAttribute() {} } },
    URLSearchParams, Date: DateClass
  });
  vm.runInContext(source, context);
  return context.window.SZVKShared;
}

const shared = loadShared();

function loadIndexHelpers(names, globals) {
  const helpers = names.map(name => {
    const match = indexHtml.match(new RegExp(`  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`));
    assert.ok(match, `index.html must define ${name}`);
    return match[0];
  });
  const context = vm.createContext(globals);
  vm.runInContext(helpers.join('\n'), context);
  return context;
}

function cloudFixture(seed, onRetry) {
  const data = copy(seed);
  const reads = [];
  const writes = [];
  const db = {
    async runTransaction(callback) {
      const attempts = onRetry ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const staged = [];
        const result = await callback({
          async get(name) {
            assert.equal(staged.length, 0, 'Firestore transactions must read both documents before writing');
            reads.push(name);
            return { exists: Object.hasOwn(data, name), data: () => copy(data[name]) };
          },
          set(name, update, options) {
            staged.push({ name, update: copy(update), options: copy(options || {}) });
          }
        });
        if (attempt + 1 < attempts) {
          onRetry(data);
          continue;
        }
        for (const write of staged) {
          writes.push(write);
          data[write.name] = write.options.merge || write.options.mergeFields
            ? { ...data[write.name], ...write.update }
            : write.update;
        }
        return result;
      }
    }
  };
  return { db, data, reads, writes };
}

test('overdue tasks move to today once, preserving task identity and metadata', () => {
  const overdue = { id: 'manual', text: 'Check GPS', done: false, author: 'Artem', time: '09:15', extra: { priority: 3 } };
  const completed = { id: 'complete', text: 'Already finished', done: true };
  const current = { id: 'current', text: 'Today', done: false };
  const future = { id: 'future', text: 'Tomorrow', done: false };
  const notes = {
    '2026-10-16': [overdue, completed],
    '2026-10-19': [current],
    '2026-10-20': [future]
  };

  assert.equal(shared.carryForwardTasks(notes, '2026-10-19'), true);
  assert.deepEqual(copy(notes['2026-10-16']), [completed]);
  assert.deepEqual(notes['2026-10-19'].map(task => task.id), ['current', 'manual']);
  assert.equal(notes['2026-10-19'][1], overdue, 'move the existing task rather than create a duplicate');
  assert.deepEqual(overdue, {
    id: 'manual', text: 'Check GPS', done: false, author: 'Artem', time: '09:15',
    extra: { priority: 3 }, carriedFrom: '2026-10-16'
  });
  assert.deepEqual(notes['2026-10-20'], [future]);
  const after = JSON.stringify(notes);
  assert.equal(shared.carryForwardTasks(notes, '2026-10-19'), false);
  assert.equal(JSON.stringify(notes), after);
});

test('catch-up crosses month, year and leap-day boundaries without merging equal text', () => {
  for (const [older, yesterday, today] of [
    ['2026-10-28', '2026-10-31', '2026-11-01'],
    ['2026-12-29', '2026-12-31', '2027-01-01'],
    ['2028-02-27', '2028-02-29', '2028-03-01']
  ]) {
    const notes = {
      [older]: [{ id: 'first', text: 'Same task text', done: false }],
      [yesterday]: [{ id: 'second', text: 'Same task text' }]
    };
    assert.equal(shared.carryForwardTasks(notes, today), true);
    assert.equal(notes[older], undefined);
    assert.equal(notes[yesterday], undefined);
    assert.deepEqual(Array.from(notes[today], task => task.id), ['first', 'second']);
    assert.deepEqual(Array.from(notes[today], task => task.carriedFrom), [older, yesterday]);
    assert.equal(shared.carryForwardTasks(notes, today), false);
  }
});

test('successive active days keep the first carried-from date and do not duplicate tasks', () => {
  const notes = { '2026-10-15': [{ id: 'a', text: 'Pending', carriedFrom: '2026-10-10' }] };
  shared.carryForwardTasks(notes, '2026-10-16');
  shared.carryForwardTasks(notes, '2026-10-19');
  assert.deepEqual(Object.keys(notes), ['2026-10-19']);
  assert.equal(notes['2026-10-19'].length, 1);
  assert.equal(notes['2026-10-19'][0].carriedFrom, '2026-10-10');
});

test('default destination uses the current Kyiv day across UTC midnight', () => {
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-12-31T22:30:00.000Z']));
    }
    static now() { return new Date('2026-12-31T22:30:00.000Z').getTime(); }
  }
  const fixedShared = loadShared(FixedDate);
  const notes = { '2026-12-31': [{ id: 'a', text: 'Pending' }] };
  assert.equal(fixedShared.carryForwardTasks(notes), true);
  assert.equal(notes['2026-12-31'], undefined);
  assert.equal(notes['2027-01-01'][0].carriedFrom, '2026-12-31');
});

test('invalid destination dates reject before any tasks are changed', () => {
  for (const target of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-01', 'bad-date', '', null]) {
    const notes = { '2026-01-01': [{ id: 'a', text: 'Pending' }] };
    const before = JSON.stringify(notes);
    assert.throws(() => shared.carryForwardTasks(notes, target));
    assert.equal(JSON.stringify(notes), before, String(target));
  }
});

test('invalid source dates and non-array buckets are preserved while valid tasks move', () => {
  const notes = {
    '2026-02-30': [{ id: 'invalid-calendar-date', text: 'Leave untouched' }],
    misc: [{ id: 'invalid-key', text: 'Leave untouched' }],
    '2026-10-15': { legacy: true },
    '2026-10-16': null,
    '2026-10-17': [{ id: 'valid', text: 'Move this' }]
  };
  const before = copy(notes);
  assert.equal(shared.carryForwardTasks(notes, '2026-10-19'), true);
  for (const key of ['2026-02-30', 'misc', '2026-10-15', '2026-10-16']) {
    assert.deepEqual(notes[key], before[key]);
  }
  assert.equal(notes['2026-10-17'], undefined);
  assert.equal(notes['2026-10-19'][0].id, 'valid');
});

test('completed-only schedules need no destination bucket and produce no changes', () => {
  const notes = { '2026-10-17': [{ id: 'done', done: true, text: 'Finished' }] };
  const before = JSON.stringify(notes);
  assert.equal(shared.carryForwardTasks(notes, '2026-10-19'), false);
  assert.equal(JSON.stringify(notes), before);
  assert.equal(shared.carryForwardTasks({}, '2026-10-19'), false);
});

test('manual tasks can carry before fresh tracker data while linked repairs stay on their source day', () => {
  const repair = { id: 'repair-7', repairId: 7, text: 'Repair', done: false, time: '10:30' };
  const notes = { '2026-10-16': [repair, { id: 'manual', text: 'Manual task', done: false }] };
  assert.equal(shared.carryForwardTasks(notes, '2026-10-19', false), true);
  assert.deepEqual(copy(notes['2026-10-16']), [repair]);
  assert.deepEqual(Array.from(notes['2026-10-19'], task => task.id), ['manual']);
  assert.equal(Object.hasOwn(repair, 'carriedFrom'), false);
  assert.equal(shared.carryForwardTasks(notes, '2026-10-19', false), false);
  assert.equal(shared.carryForwardTasks(notes, '2026-10-19', true), true);
  assert.equal(notes['2026-10-16'], undefined);
  assert.equal(notes['2026-10-19'][1], repair);
  assert.equal(repair.carriedFrom, '2026-10-16');
});

test('stale cached repairs cannot undo a fresh schedule completion or move its historical day', () => {
  for (const scheduledDone of [false, true]) {
    const repair = {
      id: 7, carrier: 'Carrier', vehicle: 'AA1234',
      workHoursTask: { dateKey: '2026-10-16' }
    };
    const notes = { '2026-10-16': [
      { id: 'repair-7', repairId: 7, text: 'Carrier · AA1234', done: scheduledDone, time: '10:30' },
      { id: 'manual', text: 'Manual task', done: false }
    ] };
    const fixture = loadIndexHelpers(['reconcileScheduleRepairs', 'carryScheduleTasks'], {
      window: { SZVKShared: loadShared() },
      hasRemoteRepairs: false, isFirebaseReady: true, linkedRepairs: [repair]
    });
    assert.equal(fixture.reconcileScheduleRepairs(notes), false);
    assert.equal(notes['2026-10-16'][0].done, scheduledDone);
    assert.equal(fixture.carryScheduleTasks(notes, '2026-10-19'), true);
    assert.equal(notes['2026-10-16'][0].id, 'repair-7');
    assert.equal(notes['2026-10-16'][0].done, scheduledDone);
    assert.deepEqual(Array.from(notes['2026-10-19'], task => task.id), ['manual']);

    fixture.linkedRepairs = [{ ...repair, repairDate: '18.10.2026', specialist: 'Artem' }];
    fixture.hasRemoteRepairs = true;
    assert.equal(fixture.reconcileScheduleRepairs(notes), !scheduledDone);
    assert.equal(fixture.carryScheduleTasks(notes, '2026-10-19'), false);
    assert.equal(notes['2026-10-16'][0].done, true);
    assert.equal(notes['2026-10-16'][0].time, '10:30');
    assert.equal(Object.hasOwn(notes['2026-10-16'][0], 'carriedFrom'), false);
    assert.deepEqual(Array.from(notes['2026-10-19'], task => task.id), ['manual']);
  }
});

test('queued repair completion applies before remote tracker data without trusting other cached repairs', () => {
  const localShared = loadShared();
  const repairs = [
    { id: 7, carrier: 'Carrier', vehicle: 'AA1234', workHoursTask: { dateKey: '2026-10-16' } },
    { id: 8, carrier: 'Other carrier', vehicle: 'BB5678', workHoursTask: { dateKey: '2026-10-16' } }
  ];
  localShared.queueRepairCompletion({
    repairId: 7, done: true, dateKey: '2026-10-19', user: { username: 'operator', name: 'Operator' }
  });
  localShared.applyPendingRepairCompletions(repairs);
  const notes = { '2026-10-16': [
    { id: 'repair-7', repairId: 7, text: 'Carrier · AA1234', done: false },
    { id: 'repair-8', repairId: 8, text: 'Other carrier · BB5678', done: true },
    { id: 'repair-9', repairId: 9, text: 'Missing from this cache', done: false }
  ] };
  const fixture = loadIndexHelpers(['reconcileScheduleRepairs', 'carryScheduleTasks'], {
    window: { SZVKShared: localShared }, hasRemoteRepairs: false, isFirebaseReady: true, linkedRepairs: repairs
  });
  assert.equal(fixture.reconcileScheduleRepairs(notes), true);
  assert.equal(notes['2026-10-16'][0].done, true);
  assert.equal(notes['2026-10-16'][1].done, true, 'unqueued stale cache cannot reopen another completed repair');
  assert.equal(notes['2026-10-16'][2].repairId, 9, 'missing local repairs cannot remove fresh schedule links');
  assert.equal(repairs[0].specialist, 'Operator');
  assert.equal(repairs[0].repairDate, '19.10.2026');
  assert.equal(fixture.carryScheduleTasks(notes, '2026-10-19'), false);
  assert.equal(notes['2026-10-19'], undefined);
});

test('local-only schedule mode can reconcile and carry its known pending repairs', () => {
  const repairs = [{ id: 7, carrier: 'Carrier', vehicle: 'AA1234', workHoursTask: { dateKey: '2026-10-16' } }];
  const notes = {};
  const fixture = loadIndexHelpers(['reconcileScheduleRepairs', 'carryScheduleTasks'], {
    window: { SZVKShared: loadShared() }, hasRemoteRepairs: false, isFirebaseReady: false, linkedRepairs: repairs
  });
  assert.equal(fixture.reconcileScheduleRepairs(notes), true);
  assert.equal(fixture.carryScheduleTasks(notes, '2026-10-19'), true);
  assert.equal(notes['2026-10-16'], undefined);
  assert.equal(notes['2026-10-19'][0].repairId, 7);
});

test('an open editor follows a carried task across a year boundary while keeping unsaved text and time', () => {
  const fields = {
    taskEditorDate: { value: '2026-12-31' },
    taskEditorText: { value: 'Unsaved edited text' },
    taskEditorTime: { value: '16:45' }
  };
  const notes = { '2027-01-01': [{ id: 7, text: 'Original text', time: '10:00' }] };
  const fixture = loadIndexHelpers(['refreshTaskEditorSource'], {
    window: { dayNotes: notes },
    activeTaskEdit: { dateKey: '2026-12-31', taskId: '7' },
    getDayTasks: key => notes[key] || [],
    document: { getElementById: id => fields[id] },
    taskCalendarView: { year: 2026, month: 11 }, taskCalendarSignature: 'old-calendar'
  });
  fixture.refreshTaskEditorSource();
  assert.equal(fixture.activeTaskEdit.dateKey, '2027-01-01');
  assert.equal(fields.taskEditorDate.value, '2027-01-01');
  assert.deepEqual(copy(fixture.taskCalendarView), { year: 2027, month: 0 });
  assert.equal(fixture.taskCalendarSignature, '');
  assert.equal(fields.taskEditorText.value, 'Unsaved edited text');
  assert.equal(fields.taskEditorTime.value, '16:45');
});

test('an open editor keeps a manually chosen destination when its source task carries forward', () => {
  const fields = {
    taskEditorDate: { value: '2027-02-03' },
    taskEditorText: { value: 'Unsaved edited text' }, taskEditorTime: { value: '16:45' }
  };
  const notes = { '2027-01-01': [{ id: 'a', text: 'Original text', time: '10:00' }] };
  const calendarView = { year: 2027, month: 1 };
  const fixture = loadIndexHelpers(['refreshTaskEditorSource'], {
    window: { dayNotes: notes }, activeTaskEdit: { dateKey: '2026-12-31', taskId: 'a' },
    getDayTasks: key => notes[key] || [], document: { getElementById: id => fields[id] },
    taskCalendarView: calendarView, taskCalendarSignature: 'selected-destination'
  });
  fixture.refreshTaskEditorSource();
  assert.equal(fixture.activeTaskEdit.dateKey, '2027-01-01');
  assert.equal(fields.taskEditorDate.value, '2027-02-03');
  assert.equal(fixture.taskCalendarView, calendarView);
  assert.equal(fixture.taskCalendarSignature, 'selected-destination');
  assert.equal(fields.taskEditorText.value, 'Unsaved edited text');
  assert.equal(fields.taskEditorTime.value, '16:45');
});

test('repair reconciliation keeps a carried task linked at its new date and preserves its fields', () => {
  const repair = {
    id: 7, carrier: 'Carrier', vehicle: 'AA1234',
    workHoursTask: { dateKey: '2026-10-15', author: 'Original author' }
  };
  const notes = {
    '2026-10-15': [{ id: 'repair-7', repairId: 7, text: 'Carrier · AA1234', done: false, author: 'Original author', time: '14:20', custom: 'keep' }]
  };
  shared.carryForwardTasks(notes, '2026-10-19');
  assert.equal(shared.reconcileRepairTasks(notes, [repair]), false);
  assert.equal(notes['2026-10-15'], undefined);
  assert.equal(notes['2026-10-19'].length, 1);
  assert.equal(notes['2026-10-19'][0].repairId, 7);
  assert.equal(notes['2026-10-19'][0].author, 'Original author');
  assert.equal(notes['2026-10-19'][0].time, '14:20');
  assert.equal(notes['2026-10-19'][0].custom, 'keep');
  assert.equal(notes['2026-10-19'][0].carriedFrom, '2026-10-15');
  repair.repairDate = '19.10.2026';
  repair.specialist = 'Artem';
  assert.equal(shared.reconcileRepairTasks(notes, [repair]), true);
  assert.equal(notes['2026-10-19'][0].done, true);
  assert.equal(notes['2026-10-15'], undefined);
});

test('cloud rollover reads fresh documents and updates only notes and timestamp', async () => {
  const cloud = cloudFixture({
    trackers: { repairs: [], inventory: [{ id: 'inventory' }], updatedAt: 100 },
    schedule: {
      dayNotes: {
        '2026-10-16': [{ id: 'overdue', text: 'Pending', author: 'Artem', time: '10:00', extra: 42 }],
        '2026-10-19': [{ id: 'other-user', text: 'Fresh task from another user' }]
      },
      overrides: { '2026-10-19': 'Oleksandr' }, monthlyDebts: { '2026-10': ['keep'] }, updatedAt: 100
    }
  });
  const trackerBefore = copy(cloud.data.trackers);
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), true);
  assert.deepEqual(cloud.reads.slice().sort(), ['schedule', 'trackers']);
  assert.equal(cloud.writes.length, 1);
  assert.equal(cloud.writes[0].name, 'schedule');
  assert.deepEqual(Object.keys(cloud.writes[0].update).sort(), ['dayNotes', 'updatedAt']);
  assert.deepEqual(cloud.writes[0].options, { mergeFields: ['dayNotes', 'updatedAt'] });
  assert.equal(typeof cloud.data.schedule.updatedAt, 'number');
  assert.deepEqual(cloud.data.trackers, trackerBefore);
  assert.deepEqual(cloud.data.schedule.overrides, { '2026-10-19': 'Oleksandr' });
  assert.deepEqual(cloud.data.schedule.monthlyDebts, { '2026-10': ['keep'] });
  assert.deepEqual(cloud.data.schedule.dayNotes['2026-10-19'].map(task => task.id), ['other-user', 'overdue']);
  assert.deepEqual(cloud.data.schedule.dayNotes['2026-10-19'][1], {
    id: 'overdue', text: 'Pending', author: 'Artem', time: '10:00', extra: 42, carriedFrom: '2026-10-16'
  });
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), false);
  assert.equal(cloud.writes.length, 1, 'repeat snapshots must not trigger redundant writes');
});

test('latest completed repair is reconciled before a stale unfinished note can move', async () => {
  const cloud = cloudFixture({
    trackers: { repairs: [{
      id: 7, carrier: 'Carrier', vehicle: 'AA1234', repairDate: '18.10.2026', specialist: 'Artem',
      workHoursTask: { dateKey: '2026-10-16' }
    }] },
    schedule: { dayNotes: {
      '2026-10-16': [{ id: 'repair-7', repairId: 7, text: 'Carrier · AA1234', done: false, time: '10:30' }]
    } }
  });
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), true);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-19'], undefined);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-16'][0].done, true);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-16'][0].time, '10:30');
  assert.equal(cloud.writes.length, 1);
  assert.equal(cloud.writes[0].name, 'schedule');
});

test('missing notes for pending repairs are reconciled and carried in the same transaction', async () => {
  const cloud = cloudFixture({
    trackers: { repairs: [{
      id: 7, carrier: 'Carrier', vehicle: 'AA1234',
      workHoursTask: { dateKey: '2026-10-16', author: 'Original author' }
    }] },
    schedule: { dayNotes: {} }
  });
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), true);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-16'], undefined);
  assert.deepEqual(cloud.data.schedule.dayNotes['2026-10-19'], [{
    id: 'repair-7', repairId: 7, text: 'Carrier · AA1234', done: false,
    author: 'Original author', carriedFrom: '2026-10-16'
  }]);
  assert.equal(cloud.writes.length, 1);
});

test('transaction retries preserve newly added tasks and the latest repair completion', async () => {
  const cloud = cloudFixture({
    trackers: { repairs: [{ id: 7, carrier: 'Carrier', vehicle: 'AA1234', workHoursTask: { dateKey: '2026-10-16' } }] },
    schedule: { dayNotes: {
      '2026-10-16': [{ id: 'repair-7', repairId: 7, text: 'Carrier · AA1234', done: false }],
      '2026-10-19': [{ id: 'current', text: 'Today' }]
    } }
  }, data => {
    data.trackers.repairs[0].repairDate = '18.10.2026';
    data.trackers.repairs[0].specialist = 'Artem';
    data.schedule.dayNotes['2026-10-17'] = [{ id: 'fresh-overdue', text: 'Added while transaction retried' }];
    data.schedule.dayNotes['2026-10-19'].push({ id: 'fresh-today', text: 'Added by another account' });
    data.schedule.monthFocusNotes = { '2026-10': 'Concurrent update' };
  });
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), true);
  assert.equal(cloud.reads.filter(name => name === 'trackers').length, 2);
  assert.equal(cloud.reads.filter(name => name === 'schedule').length, 2);
  assert.equal(cloud.writes.length, 1);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-16'][0].done, true);
  assert.deepEqual(cloud.data.schedule.dayNotes['2026-10-19'].map(task => task.id), ['current', 'fresh-today', 'fresh-overdue']);
  assert.deepEqual(cloud.data.schedule.monthFocusNotes, { '2026-10': 'Concurrent update' });
});

test('missing tracker data preserves linked tasks and still carries unfinished notes forward', async () => {
  const cloud = cloudFixture({ schedule: { dayNotes: {
    '2026-10-16': [{ id: 'repair-7', repairId: 7, text: 'Repair', done: false }]
  } } });
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), true);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-19'][0].repairId, 7);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-19'][0].carriedFrom, '2026-10-16');
  assert.equal(cloud.data.trackers, undefined);
});

test('missing schedules and unchanged schedules do not create cloud writes', async () => {
  for (const schedule of [undefined, { dayNotes: {} }, { dayNotes: {
    '2026-10-16': [{ id: 'done', text: 'Completed', done: true }],
    '2026-10-19': [{ id: 'current', text: 'Today', done: false }],
    '2026-10-20': [{ id: 'future', text: 'Future', done: false }]
  } }]) {
    const cloud = cloudFixture({ trackers: { repairs: [] }, ...(schedule ? { schedule } : {}) });
    const before = JSON.stringify(cloud.data);
    assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), false);
    assert.deepEqual(cloud.reads.slice().sort(), ['schedule', 'trackers']);
    assert.equal(cloud.writes.length, 0);
    assert.equal(JSON.stringify(cloud.data), before);
  }
});

test('a missing schedule is not created even when the tracker has linked pending repairs', async () => {
  const cloud = cloudFixture({ trackers: { repairs: [{
    id: 7, carrier: 'Carrier', vehicle: 'AA1234', workHoursTask: { dateKey: '2026-10-16' }
  }] } });
  assert.equal(await shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-10-19'), false);
  assert.equal(cloud.data.schedule, undefined);
  assert.equal(cloud.writes.length, 0);
  assert.deepEqual(cloud.reads.slice().sort(), ['schedule', 'trackers']);
});

test('cloud errors propagate without persisting a partial rollover', async () => {
  const cloud = cloudFixture({ trackers: { repairs: [] }, schedule: { dayNotes: { '2026-10-16': [{ id: 'a', text: 'Pending' }] } } });
  const before = JSON.stringify(cloud.data);
  await assert.rejects(shared.rollOverTasksInCloud(cloud.db, 'trackers', 'schedule', '2026-02-30'));
  assert.equal(cloud.writes.length, 0);
  assert.equal(JSON.stringify(cloud.data), before);
  await assert.rejects(shared.rollOverTasksInCloud({ runTransaction: async () => { throw new Error('offline'); } }, 'trackers', 'schedule', '2026-10-19'), /offline/);
});
