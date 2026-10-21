const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({
  window: { location: { search: '' }, matchMedia: () => ({ matches: false }) },
  localStorage: { getItem: () => null },
  document: { documentElement: { setAttribute() {} } },
  URLSearchParams, Date
});
vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), context);
const shared = context.window.SZVKShared;
const copy = value => JSON.parse(JSON.stringify(value));

function authFixture(localEntries = {}, sessionEntries = {}) {
  const storage = entries => {
    const data = new Map(Object.entries(entries));
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
  };
  const local = storage(localEntries);
  const session = storage(sessionEntries);
  const authContext = vm.createContext({
    window: { location: { search: '', replace() {} }, matchMedia: () => ({ matches: false }) },
    localStorage: local, sessionStorage: session,
    document: { documentElement: { setAttribute() {}, style: {} } },
    URLSearchParams, Date
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), authContext);
  return { context: authContext, shared: authContext.window.SZVKShared, local, session };
}

test('the one-time reset rejects legacy sessions in either storage without deleting work data', () => {
  for (const remember of [true, false]) {
    const fixture = authFixture({
      szvk_internal_session: JSON.stringify({ username: 'Artem', name: 'Артем', role: 'admin', active: true }),
      szvk_schedule_local_data: 'work data', szvk_trackers_data: 'repair data',
      szvk_remembered_username: 'Artem', szvk_remembered_credentials: 'legacy credentials',
      ...(remember ? { szvk_auth_token: 'old-token' } : {})
    }, remember ? {} : { szvk_auth_token: 'old-token' });
    assert.equal(fixture.shared.readAuthSession(), null);
    assert.equal(fixture.local.getItem('szvk_auth_token'), null);
    assert.equal(fixture.session.getItem('szvk_auth_token'), null);
    assert.equal(fixture.local.getItem('szvk_internal_session'), null);
    assert.equal(fixture.local.getItem('szvk_remembered_credentials'), null);
    assert.equal(fixture.local.getItem('szvk_schedule_local_data'), 'work data');
    assert.equal(fixture.local.getItem('szvk_trackers_data'), 'repair data');
    assert.equal(fixture.local.getItem('szvk_remembered_username'), 'Artem');
  }
});

test('a successful new login survives reloads and honors the remember checkbox', () => {
  for (const remember of [true, false]) {
    const fixture = authFixture();
    const saved = fixture.shared.saveAuthSession({ username: 'Artem', name: 'Артем', role: 'admin', passwordHash: 'never store in session' }, remember);
    assert.equal(saved.sessionVersion, fixture.shared.authSessionVersion);
    assert.equal(saved.passwordHash, undefined);
    assert.equal(!!fixture.local.getItem('szvk_auth_token'), remember);
    assert.equal(!!fixture.session.getItem('szvk_auth_token'), !remember);
    for (let reload = 0; reload < 3; reload++) {
      vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), fixture.context);
      assert.deepEqual(copy(fixture.context.window.SZVKShared.readAuthSession()), copy(saved));
    }
    if (!remember) {
      fixture.session.removeItem('szvk_auth_token');
      assert.equal(fixture.shared.readAuthSession(), null, 'closing the session must require login again');
    }
  }
});

test('corrupted, incomplete, disabled and outdated sessions never restore access', () => {
  const valid = { username: 'Artem', role: 'admin', active: true, sessionVersion: shared.authSessionVersion };
  for (const raw of ['{invalid json', 'null', JSON.stringify({ ...valid, sessionVersion: 'old' }), JSON.stringify({ ...valid, active: false }), JSON.stringify({ ...valid, username: '' }), JSON.stringify({ ...valid, role: 'unknown' })]) {
    const fixture = authFixture({ szvk_auth_token: 'token', szvk_internal_session: raw });
    assert.equal(fixture.shared.readAuthSession(), null);
  }
  assert.equal(authFixture({ szvk_internal_session: JSON.stringify(valid) }).shared.readAuthSession(), null);
});

test('login fetches accounts from the server and rejects offline, cached or unconfirmed credentials', async () => {
  const calls = [];
  const accounts = { adminPasswordHash: 'current hash', usersList: {} };
  const snapshot = { exists: true, metadata: { fromCache: false, hasPendingWrites: false }, data: () => accounts };
  assert.equal(await shared.fetchLoginAccounts({ get: async options => { calls.push(copy(options)); return snapshot; } }), accounts);
  assert.deepEqual(calls, [{ source: 'server' }]);
  await assert.rejects(shared.fetchLoginAccounts(null));
  await assert.rejects(shared.fetchLoginAccounts({ get: async () => { throw new Error('offline'); } }), /offline/);
  for (const invalid of [
    { ...snapshot, exists: false },
    { ...snapshot, metadata: { fromCache: true } },
    { ...snapshot, metadata: { hasPendingWrites: true } },
    { ...snapshot, data: () => null }
  ]) await assert.rejects(shared.fetchLoginAccounts({ get: async () => invalid }));
});

async function submitLogin({ username = 'Artem', password = 'new-password', accounts = {}, offline = false, remember = true, firebaseReady = true } = {}) {
  const fixture = authFixture({
    szvk_admin_pwd_hash: 'hash:old-password',
    szvk_custom_users: JSON.stringify({ operator: { username: 'operator', active: true, passwordHash: 'hash:old-password' } })
  });
  const fields = { loginInput: { value: username }, passwordInput: { value: password } };
  const button = { disabled: false, textContent: '' };
  const requests = [];
  const state = { accessApplied: 0, syncStarted: 0 };
  Object.assign(fixture.context, {
    document: { getElementById: id => fields[id] },
    loginForm: { querySelector: () => button }, loginError: { style: {} },
    rememberCheckbox: { checked: remember }, currentUser: null,
    isFirebaseReady: firebaseReady,
    DB_USERS_DOC: { get: async options => {
      requests.push(copy(options));
      if (offline) throw new Error('offline');
      return { exists: true, metadata: { fromCache: false, hasPendingWrites: false }, data: () => accounts };
    } },
    REMEMBER_USER_KEY: 'szvk_remembered_username',
    hashPassword: async value => 'hash:' + value,
    applyAccessState: () => state.accessApplied++, initRealtimeSync: () => state.syncStarted++
  });
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const handler = html.match(/  loginForm\.onsubmit = async function\(e\) \{[\s\S]*?\n  \};/)[0];
  vm.runInContext(handler, fixture.context);
  await fixture.context.loginForm.onsubmit({ preventDefault() {} });
  assert.equal(button.disabled, false, 'retry must remain available');
  return { ...fixture, fields, requests, state };
}

test('the login form accepts the current admin password and rejects cached or default passwords', async () => {
  const accounts = { adminPasswordHash: 'hash:new-password', usersList: { duplicate: { username: 'Artem', active: true, passwordHash: 'hash:old-password' } } };
  const rejected = await submitLogin({ password: 'old-password', accounts });
  assert.equal(rejected.context.currentUser, null);
  assert.equal(rejected.shared.readAuthSession(), null);
  assert.equal(rejected.state.syncStarted, 0);
  assert.equal(rejected.context.loginError.style.display, 'block');
  const accepted = await submitLogin({ accounts });
  assert.equal(accepted.shared.readAuthSession().role, 'admin');
  assert.equal(accepted.state.accessApplied, 1);
  assert.equal(accepted.state.syncStarted, 1);
  assert.equal(accepted.fields.passwordInput.value, '');
  assert.deepEqual(accepted.requests, [{ source: 'server' }]);
  const missing = await submitLogin({ accounts: {} });
  assert.equal(missing.context.currentUser, null, 'missing account configuration cannot fall back to a seed password');
});

test('user logins reject old passwords and disabled accounts and keep session-only login working', async () => {
  const account = { username: 'operator', name: 'Оператор', active: true, role: 'editor', passwordHash: 'hash:new-password' };
  const accounts = { usersList: { operator: account } };
  const rejected = await submitLogin({ username: 'operator', password: 'old-password', accounts });
  assert.equal(rejected.context.currentUser, null);
  const accepted = await submitLogin({ username: 'operator', accounts, remember: false });
  assert.equal(accepted.shared.readAuthSession().username, 'operator');
  assert.equal(accepted.local.getItem('szvk_auth_token'), null);
  assert.ok(accepted.session.getItem('szvk_auth_token'));
  const disabled = await submitLogin({ username: 'operator', accounts: { usersList: { operator: { ...account, active: false } } } });
  assert.equal(disabled.context.currentUser, null);
});

test('an unavailable server or SDK cannot authenticate through locally cached passwords', async () => {
  for (const username of ['Artem', 'operator']) {
    for (const options of [{ offline: true }, { firebaseReady: false }]) {
      const fixture = await submitLogin({ username, password: 'old-password', ...options });
      assert.equal(fixture.context.currentUser, null);
      assert.equal(fixture.local.getItem('szvk_auth_token'), null);
      assert.equal(fixture.state.syncStarted, 0);
      assert.equal(fixture.context.loginError.style.display, 'block');
    }
  }
});

test('direct Tracker Hub links redirect legacy sessions and cannot start app or cloud initialization', () => {
  const html = fs.readFileSync(path.join(root, 'trackers.html'), 'utf8');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(match => !match[1].includes('src='));
  const guard = inline.find(match => match[2].includes('// Auth guard'))[2];
  const app = inline.find(match => match[2].includes('SZVK Tracker Hub Application Logic'))[2];
  const fixture = authFixture({ szvk_auth_token: 'old-token', szvk_internal_session: JSON.stringify({ username: 'Artem', role: 'admin' }) });
  const redirects = [];
  fixture.context.window.location.replace = url => redirects.push(url);
  vm.runInContext(guard, fixture.context);
  vm.runInContext(app, fixture.context);
  assert.deepEqual(redirects, ['index.html']);
  assert.equal(fixture.context.document.documentElement.style.visibility, 'hidden');
  assert.equal(fixture.local.getItem('szvk_auth_token'), null);
  fixture.shared.saveAuthSession({ username: 'Artem', name: 'Артем', role: 'admin' }, true);
  redirects.length = 0;
  vm.runInContext(guard, fixture.context);
  assert.deepEqual(redirects, [], 'new sessions can navigate directly to Tracker Hub');
});

test('search debounce runs only the latest query and can cancel pending work', () => {
  const pending = new Map();
  let id = 0;
  context.setTimeout = (callback, delay) => { pending.set(++id, { callback, delay }); return id; };
  context.clearTimeout = timer => pending.delete(timer);
  const calls = [];
  const search = shared.debounce(function (query) { calls.push([this.name, query]); });
  const receiver = { name: 'journal', search };
  receiver.search('a');
  receiver.search('ab');
  receiver.search('abc');
  assert.equal(calls.length, 0, 'input handlers must return before rendering');
  assert.equal(pending.size, 1);
  const latest = [...pending.values()][0];
  assert.equal(latest.delay, 150);
  pending.clear();
  latest.callback();
  assert.deepEqual(calls, [['journal', 'abc']]);
  receiver.search('old query');
  search.cancel();
  assert.equal(pending.size, 0, 'clearing search must cancel stale rendering');
  receiver.search('new query');
  const next = [...pending.values()][0];
  pending.clear();
  next.callback();
  assert.deepEqual(calls, [['journal', 'abc'], ['journal', 'new query']]);
});

test('separate search controls debounce independently', () => {
  const pending = new Map();
  let id = 0;
  context.setTimeout = callback => { pending.set(++id, callback); return id; };
  context.clearTimeout = timer => pending.delete(timer);
  const calls = [];
  const journal = shared.debounce(value => calls.push(value));
  const history = shared.debounce(value => calls.push(value));
  journal('first');
  history('history');
  journal('latest');
  for (const callback of pending.values()) callback();
  assert.deepEqual(calls, ['history', 'latest']);
});

test('unchanged HTML preserves controls while changed content still updates', () => {
  let writes = 0;
  const element = { set innerHTML(value) { this.html = value; writes++; } };
  assert.equal(shared.setHtmlIfChanged(element, '<button>1</button>'), true);
  assert.equal(shared.setHtmlIfChanged(element, '<button>1</button>'), false);
  assert.equal(writes, 1);
  assert.equal(shared.setHtmlIfChanged(element, '<button>2</button>'), true);
  assert.equal(element.html, '<button>2</button>');
  assert.equal(writes, 2);
});

test('all inline scripts and shared.js have valid syntax', () => {
  for (const name of ['index.html', 'trackers.html', 'tracking Trackers/index.html']) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    for (const [, attributes, script] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (!attributes.includes('src=')) new vm.Script(script, { filename: name });
    }
    for (const [, file] of html.matchAll(/(?:src|href)="([^"?#]+)(?:[^"\s]*)"/g)) {
      if (!/^https?:/.test(file)) assert.ok(fs.existsSync(path.resolve(root, path.dirname(name), file)), `${name}: missing ${file}`);
    }
  }
});

test('both pages request the current shared assets, bypassing old browser cache', () => {
  for (const name of ['index.html', 'trackers.html']) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    for (const asset of ['shared.js', 'shared.css']) {
      const version = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
      assert.ok(html.includes(`${asset}?v=${version}`), `${name} must reference the current ${asset}; run npm run version-assets`);
    }
  }
});

test('missing or outdated shared script shows a recovery action instead of silently breaking login', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(match => !match[1].includes('src=')).at(-1)[2];
  for (const api of [undefined, { escapeHtml: () => '' }]) {
    let onReady;
    let reloads = 0;
    const message = { style: {} };
    const submit = { disabled: false };
    const added = [];
    const loginForm = { appendChild: element => added.push(element) };
    const document = {
      addEventListener: (name, callback) => { if (name === 'DOMContentLoaded') onReady = callback; },
      getElementById: id => id === 'loginErrorMessage' ? message : loginForm,
      querySelector: () => submit,
      createElement: () => ({})
    };
    vm.runInNewContext(script, { document, window: { SZVKShared: api, location: { reload: () => reloads++ } } });
    assert.doesNotThrow(() => onReady());
    assert.equal(message.style.display, 'block');
    assert.ok(message.textContent.includes('Оновіть сторінку'));
    assert.equal(submit.disabled, true);
    assert.equal(added[0].type, 'button');
    assert.equal(added[0].textContent, 'Оновити сторінку');
    added[0].onclick();
    assert.equal(reloads, 1);
  }
});

test('moving a task keeps its identity, author, completion and extra fields', () => {
  const original = { id: 'a', text: 'Перевірити трекер', author: 'Олександр', done: true, extra: 'kept' };
  const data = { '2026-10-13': [copy(original)], '2026-10-14': [{id:'b',text:'Інше завдання'}] };
  const result = shared.updateTask(data, '2026-10-13', 'a', original.text, '2026-10-14');
  assert.ok(result.moved);
  assert.ok(result.changed);
  assert.equal(data['2026-10-13'], undefined);
  assert.equal(data['2026-10-14'].length, 2);
  assert.deepEqual(copy(data['2026-10-14'][1]), original);
});

test('editing changes only the text and trims surrounding whitespace', () => {
  const data = {'2026-10-13': [{id:123,text:'Опичатка',done:false,author:'Артем'}]};
  const result = shared.updateTask(data, '2026-10-13', '123', '  Виправлено  ', '2026-10-13');
  assert.equal(result.moved, false);
  assert.equal(result.previous.text, 'Опичатка');
  assert.deepEqual(copy(data['2026-10-13'][0]), {id:123,text:'Виправлено',done:false,author:'Артем'});
});

test('unchanged task does not create a new action', () => {
  const data = {'2026-10-13': [{id:'a',text:'Завдання'}]};
  assert.equal(shared.updateTask(data,'2026-10-13','a','Завдання','2026-10-13').changed, false);
});

test('optional task time can be added, changed, cleared and preserved when moving', () => {
  const data = { '2026-10-14': [{ id: 'time-task', text: 'Виклик', done: false, author: 'Артем' }] };
  assert.equal(shared.updateTask(data, '2026-10-14', 'time-task', 'Виклик', '2026-10-14', '09:35').changed, true);
  assert.equal(data['2026-10-14'][0].time, '09:35');
  assert.equal(shared.updateTask(data, '2026-10-14', 'time-task', 'Виклик', '2026-10-14', '09:35').changed, false);
  shared.updateTask(data, '2026-10-14', 'time-task', 'Виклик', '2026-10-15');
  assert.equal(data['2026-10-15'][0].time, '09:35');
  shared.updateTask(data, '2026-10-15', 'time-task', 'Виклик', '2026-10-15', '16:00');
  shared.updateTask(data, '2026-10-15', 'time-task', 'Виклик', '2026-10-15', '');
  assert.equal(Object.hasOwn(data['2026-10-15'][0], 'time'), false);
});

test('invalid task times cannot mutate or move a task', () => {
  for (const time of ['24:00', '12:60', '9:00', '12:00:00', null]) {
    const data = { '2026-10-14': [{ id: 'a', text: 'Виклик', time: '10:00' }] };
    const before = JSON.stringify(data);
    assert.throws(() => shared.updateTask(data, '2026-10-14', 'a', 'Виклик', '2026-10-15', time));
    assert.equal(JSON.stringify(data), before);
  }
});

test('rolling back a move restores time while keeping later completion', () => {
  const data = { '2026-10-14': [{ id: 'a', text: 'Виклик', time: '10:00', done: false }] };
  const result = shared.updateTask(data, '2026-10-14', 'a', 'Виклик', '2026-10-15', '12:00');
  data['2026-10-15'][0].done = true;
  shared.restoreTaskMove(data, { fromDateKey: '2026-10-14', toDateKey: '2026-10-15', taskId: 'a', previous: result.previous });
  assert.equal(data['2026-10-14'][0].time, '10:00');
  assert.equal(data['2026-10-14'][0].done, true);
});

test('new repairs create one compact note without importing legacy repairs', () => {
  const data = { '2026-10-14': [{ id: 'manual', text: 'Нотатка' }] };
  const repairs = [
    { id: 1, date: '14.10.2026', carrier: 'Перевізник', vehicle: '123', issue: 'Довгий опис', workHoursTask: { dateKey: '2026-10-14', author: 'Артем' } },
    { id: 2, date: '14.10.2026', carrier: 'Старий', vehicle: '456' }
  ];
  assert.equal(shared.reconcileRepairTasks(data, repairs), true);
  assert.deepEqual(copy(data['2026-10-14'][1]), { id: 'repair-1', repairId: 1, text: 'Перевізник · 123', done: false, author: 'Артем' });
  assert.equal(shared.reconcileRepairTasks(data, repairs), false);
  assert.equal(data['2026-10-14'].length, 2);
});

test('repair completion and reopening follow a moved note while preserving its time and identity', () => {
  const repair = { id: 7, date: '14.10.2026', carrier: 'Перевізник', vehicle: '123', workHoursTask: { dateKey: '2026-10-14', author: 'Артем' } };
  const data = {};
  shared.reconcileRepairTasks(data, [repair]);
  shared.updateTask(data, '2026-10-14', 'repair-7', 'Змінений текст', '2027-01-01', '14:30');
  Object.assign(repair, { repairDate: '15.10.2026', specialist: 'Олександр', carrier: 'Новий перевізник' });
  shared.reconcileRepairTasks(data, [repair]);
  assert.equal(data['2026-10-14'], undefined);
  assert.deepEqual(copy(data['2027-01-01'][0]), { id: 'repair-7', repairId: 7, text: 'Новий перевізник · 123', done: true, author: 'Артем', time: '14:30' });
  repair.repairDate = '';
  shared.reconcileRepairTasks(data, [repair]);
  assert.equal(data['2027-01-01'][0].done, false);
  assert.equal(shared.reconcileRepairTasks(data, null), false, 'missing cache must preserve existing links');
  assert.equal(data['2027-01-01'].length, 1);
});

test('deleting a repair removes only its note and removes duplicate links', () => {
  const data = { '2026-10-14': [{ id: 'manual', text: 'Нотатка' }, { id: 'repair-1', repairId: 1 }], '2026-10-15': [{ id: 'duplicate', repairId: 1 }] };
  const repair = { id: 1, carrier: 'Перевізник', vehicle: '123' };
  shared.reconcileRepairTasks(data, [repair]);
  assert.equal(data['2026-10-15'], undefined);
  shared.reconcileRepairTasks(data, []);
  assert.deepEqual(copy(data), { '2026-10-14': [{ id: 'manual', text: 'Нотатка' }] });
});

test('an incomplete repair cache cannot discard a transferred note before cloud data arrives', () => {
  const data = { '2026-10-15': [{ id: 'repair-7', repairId: 7, text: 'Перевізник · 123', time: '11:45', done: false }] };
  assert.equal(shared.reconcileRepairTasks(data, [], false), false);
  const repair = { id: 7, carrier: 'Перевізник', vehicle: '123', workHoursTask: { dateKey: '2026-10-14' } };
  shared.reconcileRepairTasks(data, [repair]);
  assert.equal(data['2026-10-14'], undefined);
  assert.equal(data['2026-10-15'][0].time, '11:45');
});

test('repair notes use the same pending criteria as the repair journal', () => {
  for (const repair of [ {}, {repairDate:'В процесі',specialist:'Артем'}, {repairDate:'14.10.2026',specialist:'—'}, {repairDate:'14.10.2026',specialist:'\u200B'} ]) assert.equal(shared.isRepairPending(repair), true);
  assert.equal(shared.isRepairPending({repairDate:'14.10.2026',specialist:'Артем'}), false);
  assert.equal(shared.repairTaskDateKey({date:'31.02.2026',workHoursTask:{dateKey:'2026-10-15'}}), '2026-10-15');
  assert.equal(shared.repairTaskDateKey({date:'14.10.2026'}), '2026-10-14');
});

function fixtureCloud(seed) {
  const data = copy(seed);
  const writes = [];
  const db = {
    async runTransaction(callback) {
      const staged = [];
      const result = await callback({
        async get(name) { return { exists: Object.hasOwn(data, name), data: () => copy(data[name]) }; },
        set(name, update, options) { staged.push({ name, update: copy(update), options: copy(options || {}) }); }
      });
      for (const write of staged) {
        writes.push(write);
        data[write.name] = write.options.merge || write.options.mergeFields ? { ...data[write.name], ...write.update } : write.update;
      }
      return result;
    }
  };
  return { db, data, writes };
}

test('a tracker save atomically creates the cloud note while preserving schedule fields', async () => {
  const repair = { id: 1, date: '01.09.2026', carrier: 'Перевізник', vehicle: '123', workHoursTask: { dateKey: '2026-10-14', author: 'Автор' } };
  const cloud = fixtureCloud({ trackers: { repairs: [], inventory: [{ id: 'remote' }] }, schedule: { dayNotes: { '2026-10-15': [{ id: 'manual', text: 'Інша справа' }] }, overrides: { '2026-10-14': 'Олександр' }, monthlyDebts: { '2026-10': ['Збережено'] } } });
  await shared.saveTrackerDataAndNotes(cloud.db, 'trackers', 'schedule', { repairs: [repair], inventory: [], atCommands: [], primaryCommands: {}, firmwareVersions: {}, updatedAt: 123 }, { repairs: [], inventory: [], atCommands: [], primaryCommands: {}, firmwareVersions: {} });
  assert.equal(cloud.data.schedule.dayNotes['2026-10-14'][0].repairId, 1);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-14'][0].text, 'Перевізник · 123');
  assert.equal(cloud.data.schedule.dayNotes['2026-10-15'][0].id, 'manual');
  assert.equal(cloud.data.schedule.overrides['2026-10-14'], 'Олександр');
  assert.deepEqual(cloud.data.schedule.monthlyDebts, { '2026-10': ['Збережено'] });
  assert.deepEqual(cloud.data.trackers.inventory, [{ id: 'remote' }]);
  assert.deepEqual(cloud.writes.map(write => write.name), ['trackers', 'schedule']);
});

test('completion from a moved note uses its day and the clicking account in both cloud documents', async () => {
  const repair = { id: 1, carrier: 'Перевізник', vehicle: '123', issue: 'GPS', solution: 'Деталі', workHoursTask: { dateKey: '2026-10-14' } };
  const cloud = fixtureCloud({ trackers: { repairs: [repair, { id: 2, vehicle: 'Інше' }], inventory: [{ id: 5 }] }, schedule: { dayNotes: { '2027-01-02': [{ id: 'repair-1', repairId: 1, text: 'Перевізник · 123', time: '16:25', done: false }] }, monthFocusNotes: { '2027-01': 'Фокус' } } });
  const request = { repairId: 1, done: true, dateKey: '2027-01-02', user: { username: 'kostas', name: 'Костянтин' } };
  await shared.completeRepairTaskInCloud(cloud.db, 'trackers', 'schedule', request);
  assert.equal(cloud.data.trackers.repairs[0].repairDate, '02.01.2027');
  assert.equal(cloud.data.trackers.repairs[0].specialist, 'Костянтин');
  assert.equal(cloud.data.trackers.repairs[0].workHoursTask.completedBy, 'kostas');
  assert.equal(cloud.data.trackers.repairs[0].solution, 'Деталі');
  assert.equal(cloud.data.schedule.dayNotes['2027-01-02'][0].done, true);
  assert.equal(cloud.data.schedule.dayNotes['2027-01-02'][0].time, '16:25');
  assert.equal(cloud.data.schedule.dayNotes['2026-10-14'], undefined);
  assert.equal(cloud.data.trackers.repairs[1].vehicle, 'Інше');
  assert.equal(cloud.data.trackers.inventory[0].id, 5);
  await shared.completeRepairTaskInCloud(cloud.db, 'trackers', 'schedule', { ...request, done: false });
  assert.equal(shared.isRepairPending(cloud.data.trackers.repairs[0]), true);
  assert.equal(cloud.data.trackers.repairs[0].repairDate, '');
  assert.equal(cloud.data.trackers.repairs[0].specialist, '');
  assert.equal(cloud.data.schedule.dayNotes['2027-01-02'][0].done, false);
});

test('concurrent journal saves retain another account completion and unrelated new repairs', async () => {
  const previous = [{ id: 1, vehicle: '123', issue: 'GPS', repairDate: '', specialist: '' }];
  const remote = [{ ...previous[0], repairDate: '15.10.2026', specialist: 'Костянтин' }, { id: 3, vehicle: 'REMOTE' }];
  const merged = shared.mergeRepairChanges(previous, [{ ...previous[0], issue: 'GPRS' }, { id: 2, vehicle: 'NEW' }], remote);
  assert.equal(merged.find(repair => repair.id === 1).specialist, 'Костянтин');
  assert.equal(merged.find(repair => repair.id === 1).repairDate, '15.10.2026');
  assert.equal(merged.find(repair => repair.id === 1).issue, 'GPRS');
  assert.deepEqual(copy(merged.map(repair => repair.id)), [1, 2, 3]);
});

test('cloud reconciliation heals missing notes, removes deleted links and preserves transfer time', async () => {
  const repair = { id: 1, carrier: 'Перевізник', vehicle: '123', repairDate: '15.10.2026', specialist: 'Артем', workHoursTask: { dateKey: '2026-10-14' } };
  const cloud = fixtureCloud({ trackers: { repairs: [repair] }, schedule: { dayNotes: { '2026-10-15': [{ id: 'repair-1', repairId: 1, time: '10:30', done: false }], '2026-10-16': [{ id: 'repair-2', repairId: 2 }] }, overrides: { '2026-10-16': 'Артем' } } });
  await shared.syncRepairTasksToCloud(cloud.db, 'trackers', 'schedule');
  assert.equal(cloud.data.schedule.dayNotes['2026-10-15'][0].done, true);
  assert.equal(cloud.data.schedule.dayNotes['2026-10-15'][0].time, '10:30');
  assert.equal(cloud.data.schedule.dayNotes['2026-10-16'], undefined);
  assert.deepEqual(cloud.writes[0].options.mergeFields, ['dayNotes', 'updatedAt']);
  assert.equal(cloud.data.schedule.overrides['2026-10-16'], 'Артем');
  cloud.data.trackers.repairs.push({ ...repair, id: 3, workHoursTask: { dateKey: '2026-10-14' } });
  await shared.syncRepairTasksToCloud(cloud.db, 'trackers', 'schedule');
  assert.equal(cloud.data.schedule.dayNotes['2026-10-14'][0].repairId, 3);
});

test('completion validation leaves journal and notes intact on missing repair, invalid date or account', async () => {
  const cloud = fixtureCloud({ trackers: { repairs: [{ id: 1, vehicle: '123' }] }, schedule: { dayNotes: {} } });
  const before = JSON.stringify(cloud.data);
  for (const request of [ {repairId:2,done:true,dateKey:'2026-10-14',user:{name:'Артем'}}, {repairId:1,done:true,dateKey:'2026-02-31',user:{name:'Артем'}}, {repairId:1,done:true,dateKey:'2026-10-14',user:{}} ]) await assert.rejects(shared.completeRepairTaskInCloud(cloud.db, 'trackers', 'schedule', request));
  assert.equal(JSON.stringify(cloud.data), before);
  assert.equal(cloud.writes.length, 0);
});

test('offline completion survives stale snapshots and retries without losing its original account', async () => {
  const memory = new Map();
  context.localStorage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
  const request = { repairId: 1, done: true, dateKey: '2026-10-15', user: { username: 'kostas', name: 'Костянтин' } };
  shared.queueRepairCompletion(request);
  const cached = [{ id: 1, vehicle: '123' }];
  shared.applyPendingRepairCompletions(cached);
  assert.equal(cached[0].specialist, 'Костянтин');
  assert.equal(cached[0].repairDate, '15.10.2026');
  const offline = { runTransaction: async () => { throw new Error('offline'); } };
  await assert.rejects(shared.flushRepairCompletions(offline, 'trackers', 'schedule'));
  assert.equal(Object.keys(shared.pendingRepairCompletions()).length, 1);
  const cloud = fixtureCloud({ trackers: { repairs: [{ id: 1, vehicle: '123' }] }, schedule: { dayNotes: {} } });
  await shared.flushRepairCompletions(cloud.db, 'trackers', 'schedule');
  assert.equal(cloud.data.trackers.repairs[0].specialist, 'Костянтин');
  assert.equal(Object.keys(shared.pendingRepairCompletions()).length, 0);
  shared.queueRepairCompletion({ ...request, repairId: 2 });
  await shared.flushRepairCompletions(cloud.db, 'trackers', 'schedule');
  assert.equal(Object.keys(shared.pendingRepairCompletions()).length, 0, 'deleted repairs must not block the queue');
});

test('invalid dates, empty text, missing tasks and collisions do not lose data', () => {
  for (const [id,text,date] of [['a','Текст','2026-02-31'],['a','Текст','not-a-date'],['a',' ','2026-10-14'],['missing','Текст','2026-10-14'],['a','Текст','2026-10-15']]) {
    const data = {'2026-10-13':[{id:'a',text:'Оригінал'}],'2026-10-15':[{id:'a',text:'Інше'}]};
    const original = JSON.stringify(data);
    assert.throws(() => shared.updateTask(data,'2026-10-13',id,text,date));
    assert.equal(JSON.stringify(data), original);
  }
});

test('dates support month/year boundaries and leap days', () => {
  for (const date of ['2026-11-01','2027-01-01','2028-02-29']) assert.equal(shared.isValidDateKey(date),true);
  for (const date of ['2027-02-29','2026-13-01','2026-00-01','2026-10-00']) assert.equal(shared.isValidDateKey(date),false);
});

test('move rollback restores the previous date and text while keeping later completion', () => {
  const data={'2026-10-13':[{id:'a',text:'Оригінал',done:false,author:'Артем'}]};
  const result=shared.updateTask(data,'2026-10-13','a','Новий текст','2027-01-01');
  data['2027-01-01'][0].done=true;
  shared.restoreTaskMove(data,{fromDateKey:'2026-10-13',toDateKey:'2027-01-01',taskId:'a',previous:result.previous});
  assert.equal(data['2027-01-01'],undefined);
  assert.deepEqual(copy(data['2026-10-13'][0]),{id:'a',text:'Оригінал',done:true,author:'Артем'});
  assert.throws(() => shared.restoreTaskMove(data,{fromDateKey:'2026-10-13',toDateKey:'2027-01-01',taskId:'a',previous:result.previous}));
  assert.equal(data['2026-10-13'].length,1);
});

test('task changes preserve legacy monthly notes and other days', () => {
  const schedule={dayNotes:{'2026-10-13':[{id:'a',text:'Текст'}],'2026-11-01':[{id:'b',text:'Інше'}]},monthlyDebts:{'2026-10':[{text:'Збережена нотатка'}]},monthFocusNotes:{'2026-10':'Збережений фокус'}};
  const notes=JSON.stringify([schedule.monthlyDebts,schedule.monthFocusNotes,schedule.dayNotes['2026-11-01']]);
  shared.updateTask(schedule.dayNotes,'2026-10-13','a','Виправлено','2026-10-14');
  assert.equal(JSON.stringify([schedule.monthlyDebts,schedule.monthFocusNotes,schedule.dayNotes['2026-11-01']]),notes);
});

test('invoice toggle takes precedence over legacy invoice notes', () => {
  assert.equal(shared.needsInvoice({notes:'ВИСТАВИТИ РАХУНОК'}), true);
  assert.equal(shared.needsInvoice({solution:'Потрібно виставити рахунок'}), true);
  assert.equal(shared.needsInvoice({notes:'ВИСТАВИТИ РАХУНОК',needInvoice:false}), false);
  assert.equal(shared.needsInvoice({notes:'',needInvoice:true}), true);
  assert.equal(shared.needsInvoice({notes:'Поставили нову SIM'}), false);
});

test('shift numbers follow three-day cycles across boundaries and substitutions', () => {
  for (const [date, worker, number] of [
    ['2026-09-01','Артем',1], ['2026-09-03','Артем',3],
    ['2026-09-04','Олександр',1], ['2026-09-06','Олександр',3],
    ['2026-08-31','Олександр',3], ['2026-10-25','Артем',1],
    ['2026-10-26','Артем',2], ['2027-01-01','Артем',3], ['2027-01-02','Олександр',1]
  ]) {
    const info = shared.shiftInfo(date);
    assert.equal(info.worker,worker,date);
    assert.equal(info.shiftNum,number,date);
  }
  const substituted = shared.shiftInfo('2026-10-15', {'2026-10-15':'Олександр'});
  assert.equal(substituted.worker,'Олександр');
  assert.equal(substituted.scheduledWorker,'Артем');
  assert.equal(substituted.shiftNum,3);
  assert.equal(substituted.isEdited,true);
  assert.equal(shared.shiftInfo('2026-02-31'),null);
});

test('recent repairs include seven calendar days and newly completed old requests', () => {
  const today = '2026-10-14';
  for (const date of ['08.10.2026','14.10.2026','2026-10-13']) assert.equal(shared.isRecentRepair({date},today),true);
  for (const date of ['07.10.2026','15.10.2026','31.02.2026','В процесі','']) assert.equal(shared.isRecentRepair({date},today),false);
  assert.equal(shared.isRecentRepair({date:'01.09.2026',repairDate:'14.10.2026'},today),true);
  assert.equal(shared.isRecentRepair({date:'01.09.2026',repairDate:'В процесі'},today),false);
  assert.equal(shared.isRecentRepair({date:'24.02.2028'},'2028-03-01'),true);
  assert.equal(shared.isRecentRepair({date:'23.02.2028'},'2028-03-01'),false);
});

test('the current journal day uses Kyiv time around midnight and clock changes', () => {
  assert.equal(shared.kyivDateKey(new Date('2026-10-13T21:30:00Z')),'2026-10-14');
  assert.equal(shared.kyivDateKey(new Date('2026-10-24T21:30:00Z')),'2026-10-25');
  assert.equal(shared.kyivDateKey(new Date('2026-10-25T22:30:00Z')),'2026-10-26');
});

test('mini calendars align Monday-first weeks and include leap days and adjacent months', () => {
  const october = copy(shared.calendarMonthDays(2026,9));
  assert.equal(october.length,42);
  assert.equal(october[0].dateKey,'2026-09-28');
  assert.equal(october[41].dateKey,'2026-11-08');
  assert.equal(october.filter(day=>day.inMonth).length,31);
  assert.equal(october.find(day=>day.dateKey==='2026-10-15').day,15);
  const leap = copy(shared.calendarMonthDays(2028,1));
  assert.equal(leap.filter(day=>day.inMonth).length,29);
  assert.ok(leap.some(day=>day.dateKey==='2028-02-29' && day.inMonth));
  const january = copy(shared.calendarMonthDays(2027,0));
  assert.equal(january[0].dateKey,'2026-12-28');
  assert.equal(january[41].dateKey,'2027-02-07');
  assert.equal(shared.calendarMonthDays(2026,12).length,0);
});
