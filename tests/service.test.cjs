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
