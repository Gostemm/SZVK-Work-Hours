// Browser regression checks use isolated local fixtures and block external traffic.
// Requires Node 22+ and Chrome (or SZVK_BROWSER_PATH pointing to a Chromium browser).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const authContext = vm.createContext({
  window: { location: { search: '' }, matchMedia: () => ({ matches: false }) },
  localStorage: { getItem: () => null },
  document: { documentElement: { setAttribute() {} } }, URLSearchParams
});
vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), authContext);
const sessionVersion = authContext.window.SZVKShared.authSessionVersion;

async function main() {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'szvk-browser-check-'));
  const browserPath = process.env.SZVK_BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const server = http.createServer((req, res) => {
    const filename = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['index.html','trackers.html','shared.js','shared.css','tracker_data.js'].includes(filename)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, filename)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + artifacts, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  console.log('Launching isolated Chromium');
  let socket;
  try {
    const portFile = path.join(artifacts, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await sleep(100);
    assert.ok(fs.existsSync(portFile), 'Chromium must start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(()=>reject(new Error('Chromium connection timed out')),5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = error => { clearTimeout(timer); reject(error); };
    });
    let nextId = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); },10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
      throw new Error('Timed out: ' + expression);
    };
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['https://*', 'http://*.google*'] });
    const trackerFixture = {
      repairs: [{ id:1,date:'13.10.2026',vehicle:'TEST-001',carrier:'Тестовий перевізник',reportedBy:'Тестовий заявник',serial:'000001',issue:'Немає GPS',specialist:'Саша_old',repairDate:'',solution:'',notes:'ВИСТАВИТИ РАХУНОК' }],
      inventory: [], atCommands: [{ id:1,cmd:'AT+TEST',desc:'Тестова команда',notes:'' }]
    };
    const repair = (id, date, repairDate = '') => ({ id, date, repairDate, vehicle:'ARCHIVE-' + id,carrier:'Тестовий перевізник',serial:'TEST-' + id,issue:'Тестовий ремонт ' + id,specialist:repairDate ? 'Артем' : '',solution:repairDate ? 'Виконано' : '',notes:'' });
    trackerFixture.repairs.push(repair(2,'08.10.2026'),repair(3,'07.10.2026'),repair(4,'01.09.2026','14.10.2026'),repair(5,'15.10.2026'));
    for (let i=10;i<75;i++) trackerFixture.repairs.push(repair(i,'30.09.2026'));
    trackerFixture.inventory = [
      {id:1,serial:'TEST-OFFICE',receivedDate:'13.10.2026',status:'Офіс',assignedTo:''},
      {id:2,serial:'TEST-INSTALLED',receivedDate:'13.10.2026',status:'Встановлено',assignedTo:'Тестовий перевізник'}
    ];
    const scheduleFixture = { overrides: {'2026-10-15':'Олександр'}, dayNotes: {'2026-10-14':[{id:'test-task',text:'Перевірити трекер та живлення у тестовому автобусі',author:'Олександр',done:false}]},monthlyDebts:{},monthFocusNotes:{} };
    scheduleFixture.dayNotes['2026-10-16'] = [
      { id:'calendar-active',text:'Активна справа для лічильника',done:false },
      ...Array.from({length:9},(_,index)=>({id:'calendar-done-'+index,text:'Виконана справа '+(index+1),done:true}))
    ];
    scheduleFixture.dayNotes['2026-10-12'] = [
      { id:'overdue-task', text:'Незавершена справа', author:'Костянтин', done:false, extra:'preserved' },
      { id:'completed-task', text:'Завершена справа', done:true, time:'10:30' }
    ];
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-14T12:00:00+03:00'])); } static now() { return new Date('2026-10-14T12:00:00+03:00').getTime(); } };
      if (!localStorage.getItem('szvk_browser_fixture')) {
        localStorage.setItem('szvk_browser_fixture','1');
        localStorage.setItem('szvk_auth_token','isolated-test-token');
        localStorage.setItem('szvk_internal_session',JSON.stringify({username:'test',name:'Артем',role:'user',active:true,sessionVersion:${JSON.stringify(sessionVersion)}}));
        localStorage.setItem('szvk_trackers_data',${JSON.stringify(JSON.stringify(trackerFixture))});
        localStorage.setItem('szvk_schedule_local_data',${JSON.stringify(JSON.stringify(scheduleFixture))});
      }
      window.__copiedCommand = '';
      Object.defineProperty(navigator,'clipboard',{value:{writeText: async text => {window.__copiedCommand=text;}}});
    ` });
    const navigate = async page => {
      console.log('Checking ' + page);
      await call('Page.navigate', { url: url + '/' + page });
      await waitFor("document.readyState==='complete' && !!document.querySelector('#accountMount button')");
    };
    const checkModalGeometry = async (modalId, controlId) => {
      for (const [width, height] of [[320,480], [740,320]]) {
        await call('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:true });
        await evaluate("document.documentElement.style.setProperty('--safe-area-bottom','34px')");
        assert.equal(await evaluate(`(()=>{const box=document.querySelector('#${modalId} > .modal-box').getBoundingClientRect();return box.top>=16 && box.bottom<=innerHeight-49 && box.left>=0 && box.right<=innerWidth;})()`), true, 'dialog fits the visible screen above system navigation');
        await evaluate(`document.querySelector('#${controlId}').scrollIntoView({block:'end'})`);
        assert.equal(await evaluate(`(()=>{const button=document.querySelector('#${controlId}').getBoundingClientRect();return button.top>=16 && button.bottom<=innerHeight-49;})()`), true, 'bottom action is reachable on a short screen');
      }
      await evaluate("document.documentElement.style.removeProperty('--safe-area-bottom')");
      await call('Emulation.setDeviceMetricsOverride', { width:320,height:800,deviceScaleFactor:1,mobile:true });
    };
    await call('Emulation.setDeviceMetricsOverride', { width:320,height:800,deviceScaleFactor:1,mobile:true });
    await navigate('trackers.html');
    await waitFor("typeof window.editRepair==='function'");
    assert.equal(await evaluate("document.querySelector('#tabBtnHistory').closest('.account-panel')!==null"), true);
    assert.equal(await evaluate("document.querySelector('.brand-badge')===null && document.querySelector('#atSearchInput')===null"), true);
    assert.equal(await evaluate("document.querySelector('#recentRepairTableBody [data-repair-id=\"1\"] td[colspan=\"3\"] .btn-finish-repair').textContent.trim()"), 'Звітувати про завершення ремонту');
    assert.equal(await evaluate("document.querySelector('#recentRepairTableBody [data-repair-id=\"1\"] .repair-result-cell').children.length"), 1, 'pending result columns contain only the report button');
    assert.equal(await evaluate(`(()=>{
      const row=document.querySelector('#recentRepairTableBody [data-repair-id="1"]');
      const cell=row.querySelector('.repair-result-cell').getBoundingClientRect();
      const button=row.querySelector('.btn-finish-repair').getBoundingClientRect();
      const headings=row.closest('table').tHead.rows[0].cells;
      return Math.abs(cell.left-headings[5].getBoundingClientRect().left)<2 && Math.abs(cell.right-headings[7].getBoundingClientRect().right)<2 && button.width>=cell.width-25 && button.height>=52;
    })()`), true, 'prominent completion button spans date, specialist and solution columns');
    assert.equal(await evaluate("document.querySelector('#recentRepairTableBody [data-repair-id=\"4\"] .btn-finish-repair')===null"), true, 'completed repairs have no completion action');
    await call('Emulation.setDeviceMetricsOverride', { width:1280,height:900,deviceScaleFactor:1,mobile:false });
    await evaluate("document.querySelector('#recentRepairTableBody [data-repair-id=\"1\"] .btn-finish-repair').scrollIntoView({block:'center',inline:'center'})");
    const reportTheme = await evaluate("document.documentElement.getAttribute('data-theme')");
    for (const theme of ['dark','light']) {
      await evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)})`);
      const reportShot = await call('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(artifacts,`repair-report-${theme}.png`),Buffer.from(reportShot.data,'base64'));
    }
    await evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(reportTheme)})`);
    await call('Emulation.setDeviceMetricsOverride', { width:320,height:800,deviceScaleFactor:1,mobile:true });
    await evaluate("document.querySelector('#recentRepairTableBody').closest('.table-container').scrollLeft=0;window.scrollTo(0,0)");
    await evaluate("document.querySelector('#recentRepairTableBody [data-repair-id=\"1\"] .btn-finish-repair').click()");
    assert.equal(await evaluate("document.querySelector('#repairModalOverlay').classList.contains('active') && !document.querySelector('#repairResultPanel').hidden"), true, 'completion action opens result form directly');
    assert.equal(await evaluate("document.querySelector('#inputVehicle').value"), 'TEST-001');
    assert.equal(await evaluate("document.querySelector('#checkboxInvoice').checked"), true);
    await checkModalGeometry('repairModalOverlay', 'btnSaveRepairModal');
    await evaluate("document.querySelector('#closeRepairModalBtn').click()");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#recentRepairTableBody [data-repair-id]')].map(row=>Number(row.dataset.repairId)).sort((a,b)=>a-b)"),[1,2,4]);
    assert.equal(await evaluate("document.querySelectorAll('[data-repair-table] thead').length"),2);
    assert.equal(await evaluate("document.querySelector('#repairArchive').open"),false);
    assert.equal(await evaluate("document.querySelector('#repairTableBody').children.length"),0,'full table stays unmounted while collapsed');
    const weeklyShot = await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'weekly-repairs-mobile.png'),Buffer.from(weeklyShot.data,'base64'));
    await evaluate("document.querySelector('#repairArchive').open=true");
    await waitFor("document.querySelector('#repairTableBody').children.length===50");
    await evaluate("document.querySelector('#pageSizeSelect').value='all';document.querySelector('#pageSizeSelect').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("document.querySelector('#repairTableBody').children.length"),70);
    assert.equal(await evaluate("document.querySelector('#recentRepairTableBody').closest('table').tHead.innerHTML===document.querySelector('#repairTableBody').closest('table').tHead.innerHTML"),true,'both tables share identical columns');
    assert.equal(await evaluate("[...document.querySelectorAll('#recentRepairTableBody [data-repair-id]')].every(row=>row.innerHTML===document.querySelector('#repairTableBody [data-repair-id=\"'+row.dataset.repairId+'\"]').innerHTML)"),true,'weekly and archive rows use identical content');
    await evaluate("document.querySelector('#repairArchive').open=false");
    await waitFor("document.querySelector('#repairTableBody').children.length===0");
    await evaluate("document.querySelector('#pageSizeSelect').value='25';document.querySelector('#pageSizeSelect').dispatchEvent(new Event('change'));document.querySelector('#globalSearchInput').value='ARCHIVE';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'))");
    await waitFor("document.querySelector('#recentRepairTableBody').children.length===69");
    assert.equal(await evaluate("document.querySelector('#repairArchive').hidden"),true,'search hides the archive disclosure');
    assert.equal(await evaluate("document.querySelector('#recentRepairsTitle').textContent"),'Результати пошуку');
    await evaluate("document.querySelector('#globalSearchInput').value='ARCHIVE-74';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'))");
    await waitFor("document.querySelector('#recentRepairTableBody [data-repair-id=\"74\"]')!==null && document.querySelector('#recentRepairTableBody').children.length===1");
    assert.equal(await evaluate("document.querySelector('#repairTableBody').children.length"),0);
    await evaluate("document.querySelector('#globalSearchInput').value='NO-MATCH-ANYWHERE';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'))");
    await waitFor("document.querySelector('#recentRepairTableBody .repair-table-empty')!==null");
    assert.equal(await evaluate("document.querySelectorAll('#recentRepairTableBody [data-repair-id]').length"),0);
    await evaluate("document.querySelector('#globalSearchInput').value='   ';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'))");
    await waitFor("!document.querySelector('#repairArchive').hidden && document.querySelectorAll('#recentRepairTableBody [data-repair-id]').length===3");
    await evaluate("document.querySelector('#searchClearBtn').click();document.querySelector('#repairArchive').open=true");
    await waitFor("document.querySelector('#repairTableBody').children.length===25");
    await evaluate("document.querySelector('#globalSearchInput').value='ARCHIVE-74';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'))");
    await waitFor("document.querySelector('#repairArchive').hidden");
    await evaluate("document.querySelector('#searchClearBtn').click()");
    assert.equal(await evaluate("document.querySelector('#repairArchive').open && !document.querySelector('#repairArchive').hidden && document.querySelector('#repairTableBody').children.length===25"),true,'clearing search restores the previous archive view');
    await evaluate("document.querySelector('#repairArchive').open=false");
    await evaluate("document.querySelector('#btnOpenAddModal').click()");
    assert.equal(await evaluate("!document.querySelector('#repairRequestPanel').hidden && document.querySelector('#repairResultPanel').hidden"),true);
    await evaluate(`document.querySelector('#inputVehicle').value='TEST-002';document.querySelector('#inputCarrierSelect').value='Тестовий перевізник';document.querySelector('#inputCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('[data-issue]').click();document.querySelector('#btnSaveRepairModal').click()`);
    let data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.repairs[0].carrier,'Тестовий перевізник');
    assert.equal(data.repairs[0].needInvoice,false);
    assert.equal(data.repairs[0].repairDate,'');
    const linkedRepairId = data.repairs[0].id;
    const initialRepairNote = await evaluate("Object.values(JSON.parse(localStorage.getItem('szvk_schedule_local_data')).dayNotes).flat().find(task=>task.repairId===" + linkedRepairId + ")");
    assert.equal(initialRepairNote.text, 'Тестовий перевізник · TEST-002');
    assert.equal(initialRepairNote.done, false);
    await evaluate("window.editRepair(1)");
    assert.equal(await evaluate("document.querySelector('#inputSpecialistCustom').value"),'Саша_old');
    assert.equal(await evaluate("document.querySelector('#checkboxInvoice').checked"),true);
    await evaluate("document.querySelector('#btnSaveRepairModal').click();window.editRepair(1)");
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.repairs.find(item=>item.id===1).specialist,'Саша_old','legacy specialist survives saving without changes');
    await evaluate(`document.querySelector('#repairResultTab').click();document.querySelector('#inputSpecialist').value='__custom';document.querySelector('#inputSpecialist').dispatchEvent(new Event('change'));document.querySelector('#inputSpecialistCustom').value='Тестовий майстер';document.querySelector('#inputSolution').value='Замінено антену';document.querySelector('#inputRepairDate').value='14.10.2026';document.querySelector('#checkboxInvoice').checked=false;document.querySelector('#btnSaveRepairModal').click()`);
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.repairs.find(item=>item.id===1).specialist,'Тестовий майстер');
    assert.equal(data.repairs.find(item=>item.id===1).needInvoice,false);
    assert.equal(await evaluate("document.querySelector('#recentRepairTableBody [data-repair-id=\"1\"] .btn-finish-repair')===null"), true, 'completion removes the action');
    await evaluate(`document.querySelector('#btnOpenAddModal').click();document.querySelector('#inputVehicle').value='TEST-003';document.querySelector('#inputCarrierSelect').value='__custom';document.querySelector('#inputCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('#inputCarrierCustom').value='Новий тестовий перевізник';document.querySelector('#inputCarrierCustom').dispatchEvent(new Event('input'));document.querySelector('[data-issue]').click();document.querySelector('#btnSaveRepairModal').click()`);
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.repairs[0].carrier,'Новий тестовий перевізник');
    await evaluate("document.querySelector('#tabBtnInventory').click()");
    assert.equal(await evaluate("document.querySelector('#invCountInstalled')===null && document.querySelector('#invCountTotal')===null"),true);
    assert.equal(await evaluate("document.querySelector('#invCountOffice').textContent"),'1 шт');
    await evaluate("document.querySelector('#btnOpenAddInventoryModal').click()");
    const inventoryShot = await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'inventory-carrier-mobile.png'),Buffer.from(inventoryShot.data,'base64'));
    await evaluate("document.querySelector('#invInputSerial').value='TEST-SINGLE';document.querySelector('#invCarrierSelect').value='Тестовий перевізник';document.querySelector('#invCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('#inventoryForm').requestSubmit()");
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.inventory[0].assignedTo,'Тестовий перевізник');
    await evaluate("document.querySelector('#btnOpenBulkInventoryModal').click();document.querySelector('#bulkCarrierSelect').value='Новий тестовий перевізник';document.querySelector('#bulkCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('#bulkInputSerials').value='TEST-BULK-A\\nTEST-BULK-B';document.querySelector('#bulkInventoryForm').requestSubmit()");
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.inventory.length,5);
    assert.equal(data.inventory[0].assignedTo,'Новий тестовий перевізник');
    assert.equal(data.inventory[1].assignedTo,'Новий тестовий перевізник');
    assert.equal(await evaluate("document.querySelector('#invCountOffice').textContent"),'4 шт');
    await evaluate("document.querySelector('#tabBtnAtCommands').click();document.querySelector('#btnEditCommands').click()");
    const editedCommand = 'AT+TEST="quoted",\'apostrophe\'\nAT+SECOND';
    await evaluate(`document.querySelector('#referenceCommandText').value=${JSON.stringify(editedCommand)};document.querySelector('#referenceEditorForm').requestSubmit()`);
    await evaluate("document.querySelector('[data-copy-command]').click()");
    assert.equal(await evaluate('window.__copiedCommand'),editedCommand);
    await evaluate("document.querySelector('#btnEditCommands').click();document.querySelector('#referenceCommandSelect').value='prim_dual_tgprs';document.querySelector('#referenceCommandSelect').dispatchEvent(new Event('change'));document.querySelector('#referenceCommandTitle').value='<img src=x onerror=window.__injected=true>';document.querySelector('#referenceVodafoneText').value='AT+TESTV';document.querySelector('#referenceKyivstarText').value='AT+TESTK';document.querySelector('#referenceEditorForm').requestSubmit()");
    assert.equal(await evaluate("document.querySelector('#atCommandsGrid img')===null && !window.__injected"),true,'edited descriptions must render as text');
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.primaryCommands.prim_dual_tgprs.kyivstar,'AT+TESTK');
    await evaluate("document.querySelector('#btnEditCommands').click();document.querySelector('#referenceCommandSelect').value='extra:0';document.querySelector('#referenceCommandSelect').dispatchEvent(new Event('change'));document.querySelector('#referenceCommandText').value='AT+EDITED';document.querySelector('#referenceEditorForm').requestSubmit()");
    await evaluate("document.querySelector('#btnEditFirmware').click();document.querySelector('#firmwareBlack').value='SW TEST / HW TEST';document.querySelector('#referenceEditorForm').requestSubmit()");
    await navigate('trackers.html?tab=at');
    await waitFor("document.querySelector('.fw-version-black').textContent==='SW TEST / HW TEST'");
    assert.equal(await evaluate("document.querySelector('[data-copy-command]').dataset.copyCommand"),editedCommand);
    assert.equal(await evaluate("document.querySelector('#atCommandsGrid').textContent.includes('AT+EDITED')"),true);
    await evaluate("document.querySelector('#userProfileMenu').open=true;document.querySelector('#tabBtnHistory').click()");
    assert.equal(await evaluate("document.querySelector('#viewHistory').style.display==='flex' && !document.querySelector('#userProfileMenu').open"),true);
    for (const width of [320,390,768,1440]) {
      await call('Emulation.setDeviceMetricsOverride', { width,height:900,deviceScaleFactor:1,mobile:width<768 });
      await evaluate("document.querySelector('#tabBtnJournal').click();window.editRepair(1)");
      assert.ok(await evaluate(`document.querySelector('#inputVehicle').getBoundingClientRect().width>=${width<768?200:150}`),'request field must retain readable width');
      await evaluate("document.querySelector('#repairResultTab').click()");
      assert.ok(await evaluate("document.querySelector('#inputNotes').getBoundingClientRect().width>=200"),'visible notes field width');
      assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),true,'no page overflow');
      if (width===320) {
        const shot=await call('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(artifacts,'tracker-mobile.png'),Buffer.from(shot.data,'base64'));
      }
      await evaluate("document.querySelector('#closeRepairModalBtn').click()");
    }
    await call('Emulation.setDeviceMetricsOverride', { width:320,height:800,deviceScaleFactor:1,mobile:true });
    await navigate('index.html');
    await waitFor("document.querySelector('#mainAppContainer').style.display==='flex'");
    assert.equal(await evaluate("!document.querySelector('#btnToggleCycleTasks, #cycleTasksBlock, #btnOpenResetModal, #resetPeriodModal, .month-daily-badge')"),true,'retired controls and monthly task badges are removed');
    assert.equal(await evaluate("document.querySelector('#monthTabsContainer .active').textContent"),'Жовтень (31)','month labels retain the number of days');
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    assert.deepEqual(await evaluate(`(()=>{
      const tabs=document.querySelector('#monthTabsContainer').children;
      tabs[0].click();
      const view=document.querySelector('#mainCalendarView');
      const animation=view.getAnimations()[0];
      tabs[0].click();
      const steady=view.getAnimations()[0]===animation;
      tabs[1].click();
      return {animated:!!animation,steady,replaced:view.getAnimations()[0]!==animation};
    })()`),{animated:true,steady:true,replaced:true},'navigation animates once and ordinary rerenders keep the same animation');
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate("document.querySelector('#monthTabsContainer').children[0].click();document.querySelector('#mainCalendarView').getAnimations().length"),0,'reduced motion cancels and skips view animations');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#btnGoToToday')).transitionDuration"),'0s','reduced motion disables button transitions');
    await evaluate("document.querySelector('#monthTabsContainer').children[1].click()");
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    assert.deepEqual(await evaluate("window.dayNotes['2026-10-14'].find(task=>task.id==='overdue-task')"), { id:'overdue-task', text:'Незавершена справа', author:'Костянтин', done:false, extra:'preserved', carriedFrom:'2026-10-12' });
    assert.equal(await evaluate("window.dayNotes['2026-10-12'].length===1 && window.dayNotes['2026-10-12'][0].id==='completed-task'"), true, 'completed tasks stay on the original date');
    assert.equal(await evaluate("document.querySelector('#btnTabHistory').closest('.account-panel')!==null"),true);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.day-card[data-date=\"2026-10-16\"] .counter-value')].map(value=>value.textContent)"),['1','9'],'calendar counts active and completed tasks separately');
    assert.equal(await evaluate("!document.querySelector('.day-card[data-date=\"2026-10-12\"] .day-task-counter.active') && !document.querySelector('.day-card[data-date=\"2026-10-14\"] .day-task-counter.done') && !document.querySelector('.day-card[data-date=\"2026-10-17\"] .day-task-counter')"),true,'empty categories and days have no counter');
    await evaluate("document.querySelector('.day-card[data-date=\"2026-10-16\"] .day-task-counter.done').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks').open"),true,'completed counter opens the completed list');
    await evaluate("document.querySelector('#modalDayCloseX').click();document.querySelector('.day-card[data-date=\"2026-10-16\"] .day-task-counter.active').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks').open"),false,'active counter opens active notes with completed notes collapsed');
    assert.equal(await evaluate("document.querySelectorAll('#modalDayTasksList > .task-modal-item').length"),1);
    await evaluate("document.querySelector('#modalDayCloseX').click()");
    for (const width of [320,390,420,480,600,768,1280]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768});
      await evaluate("document.querySelector('.day-card[data-date=\"2026-10-16\"]').scrollIntoView({block:'center'})");
      const counterLayout = await evaluate(`(()=>{const card=document.querySelector('.day-card[data-date="2026-10-16"]');const bounds=card.getBoundingClientRect();const buttons=[...card.querySelectorAll('.day-task-counter')].map(button=>button.getBoundingClientRect().toJSON());return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,card:bounds.toJSON(),buttons,values:[...card.querySelectorAll('.counter-value')].map(value=>({width:value.clientWidth,scrollWidth:value.scrollWidth}))};})()`);
      assert.equal(await evaluate(`(()=>{const reference=document.querySelector('.day-card[data-date="2026-10-16"] .day-task-counter').getBoundingClientRect();return ['2026-10-12','2026-10-14'].every(date=>{const group=document.querySelector('.day-card[data-date="'+date+'"] .day-task-counters');const bounds=group.getBoundingClientRect();const button=group.firstElementChild.getBoundingClientRect();return group.children.length===1 && Math.abs(button.width-reference.width)<1 && Math.abs(button.height-reference.height)<1 && Math.abs((button.left+button.right)-(bounds.left+bounds.right))<1;});})()`),true,'single active and completed counters match paired counters in size and stay centered');
      if(width===320 || width===1280) {
        const calendarShot=await call('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(artifacts,width===320?'calendar-status-mobile.png':'calendar-status-desktop.png'),Buffer.from(calendarShot.data,'base64'));
      }
      assert.equal(Math.abs(counterLayout.buttons[0].top-counterLayout.buttons[1].top)<1 && counterLayout.buttons[0].right<=counterLayout.buttons[1].left && counterLayout.buttons[0].left>=counterLayout.card.left && counterLayout.buttons[1].right<=counterLayout.card.right && counterLayout.values.every(value=>value.scrollWidth<=value.width) && counterLayout.pageWidth<=counterLayout.width,true,'both counters stay side by side and fit the calendar cell: '+JSON.stringify(counterLayout)+'; screenshots: '+artifacts);
    }
    await call('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:true});
    await evaluate("window.scrollTo(0,0)");
    await evaluate("[...document.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='12').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks').open"),false,'a completed-only day starts collapsed');
    assert.equal(await evaluate("document.querySelectorAll('#modalDayTasksList > .task-modal-item').length"),0);
    await evaluate("document.querySelector('#modalDayCloseX').click()");
    await evaluate("[...document.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='14').click()");
    await waitFor("!!document.querySelector('.move-task')");
    const activeCounterBefore = await evaluate("Number(document.querySelector('.day-card[data-date=\"2026-10-14\"] .day-task-counter.active .counter-value').textContent)");
    await evaluate("[...document.querySelectorAll('#modalDayTasksList .task-modal-item')].find(row=>row.textContent.includes('Незавершена справа')).querySelector('.task-modal-checkbox').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList').lastElementChild.matches('details.completed-tasks:not([open])')"),true,'completed tasks move to a collapsed group at the bottom');
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks summary').textContent"),'Виконані завдання (1)');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.day-card[data-date=\"2026-10-14\"] .counter-value')].map(value=>Number(value.textContent))"),[activeCounterBefore-1,1],'completion updates both calendar counts');
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .task-modal-item.done').checkVisibility()"),false,'completed task text is hidden while collapsed');
    const completedNotesShot = await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'completed-notes-mobile.png'),Buffer.from(completedNotesShot.data,'base64'));
    await evaluate("document.querySelector('#modalNewTaskInput').value='Тест групування';document.querySelector('#modalAddNewTaskBtn').click();[...document.querySelectorAll('#modalDayTasksList .task-modal-item')].find(row=>row.textContent.includes('Тест групування')).querySelector('.task-modal-checkbox').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks summary').textContent"),'Виконані завдання (2)');
    await evaluate("document.querySelector('#modalDayTasksList .completed-tasks summary').click();[...document.querySelectorAll('#modalDayTasksList .task-modal-item')].find(row=>row.textContent.includes('Тест групування')).querySelector('.delete-task').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks').open"),true,'expanded completed group stays open after an update');
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].some(task=>task.id==='test-task') && window.dayNotes['2026-10-14'].find(task=>task.id==='overdue-task').done && !window.dayNotes['2026-10-14'].some(task=>task.text==='Тест групування')"),true,'deleting from a grouped list removes the correct task');
    await evaluate("document.querySelector('#modalDayTasksList .completed-tasks .task-modal-checkbox').click()");
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList .completed-tasks')===null && !window.dayNotes['2026-10-14'].find(task=>task.id==='overdue-task').done"),true,'reopening restores the active task and removes an empty completed group');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.day-card[data-date=\"2026-10-14\"] .counter-value')].map(value=>Number(value.textContent))"),[activeCounterBefore],'reopening hides the completed counter once its count reaches zero');
    assert.ok(await evaluate("document.querySelector('.task-modal-text').getBoundingClientRect().width>=180"),'mobile task text must retain width');
    const shot=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'work-hours-mobile.png'),Buffer.from(shot.data,'base64'));
    await evaluate("document.querySelector('.move-task').click()");
    await checkModalGeometry('taskEditorModal', 'taskEditorSave');
    assert.equal(await evaluate("document.querySelectorAll('#taskCalendarDays button').length"),42);
    assert.equal(await evaluate("document.querySelector('#taskCalendarDays button').dataset.date"),'2026-09-28');
    assert.equal(await evaluate("document.querySelector('#taskCalendarDays [aria-current=\"date\"]').dataset.date"),'2026-10-14');
    await evaluate("document.querySelector('#taskCalendarNext').click();document.querySelector('#taskCalendarNext').click();document.querySelector('#taskCalendarNext').click()");
    assert.equal(await evaluate("document.querySelector('#taskCalendarMonth').textContent"),'Січень 2027');
    await evaluate("document.querySelector('#taskCalendarDays [data-date=\"2027-01-02\"]').click()");
    assert.equal(await evaluate("document.querySelector('#taskEditorDate').value"),'2027-01-02');
    assert.equal(await evaluate("document.querySelector('#taskEditorShift').textContent.includes('Олександр') && document.querySelector('#taskEditorShift').textContent.includes('зміна №1')"),true);
    await evaluate("document.querySelector('#taskCalendarDays [aria-pressed=\"true\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
    assert.equal(await evaluate("document.querySelector('#taskEditorDate').value"),'2027-01-01');
    await evaluate("document.querySelector('#taskCalendarPrev').click();document.querySelector('#taskCalendarPrev').click();document.querySelector('#taskCalendarPrev').click();document.querySelector('#taskCalendarDays [data-date=\"2026-10-15\"]').click()");
    assert.equal(await evaluate("document.querySelector('#taskEditorShift').textContent.includes('Олександр (підміна)')"),true);
    assert.equal(await evaluate("document.querySelector('#taskEditorShift').textContent.includes('зміна №3 з 3') && document.querySelector('#taskEditorShift').textContent.includes('четвер')"),true);
    assert.equal(await evaluate("document.querySelector('#taskCalendarDays [data-date=\"2026-10-15\"]').classList.contains('oleksandr')"),true);
    assert.equal(await evaluate("document.querySelector('#taskCalendarDays [data-date=\"2026-10-15\"]').querySelector('.task-calendar-substitution')!==null"),true);
    assert.equal(await evaluate("document.querySelector('#taskCalendarDays [aria-pressed=\"true\"]').dataset.date"),'2026-10-15');
    assert.equal(await evaluate("[...document.querySelectorAll('#taskCalendarDays button')].every(button=>button.scrollWidth<=button.clientWidth)"),true,'calendar text must fit on mobile');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.task-modal-text')).fontWeight"),'650');
    const shiftShot=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'shift-transfer-mobile.png'),Buffer.from(shiftShot.data,'base64'));
    await evaluate("document.querySelector('#taskEditorSave').click()");
    const schedule = await evaluate("JSON.parse(localStorage.getItem('szvk_schedule_local_data'))");
    assert.equal((schedule.dayNotes['2026-10-14'] || []).some(task => task.id === 'test-task'), false);
    assert.equal(schedule.dayNotes['2026-10-15'][0].id,'test-task');
    assert.equal(schedule.dayNotes['2026-10-15'][0].author,'Олександр');
    assert.equal(schedule.dayNotes['2026-10-15'][0].done,false);
    await evaluate("document.querySelector('#taskEditorModal').classList.remove('active');document.querySelector('#modalDayCloseX').click();document.querySelector('#userProfileMenu').open=true;document.querySelector('#btnTabHistory').click()");
    assert.equal(await evaluate("document.querySelector('#historyView').style.display==='block' && !document.querySelector('#userProfileMenu').open"),true);

    await navigate('index.html');
    await waitFor("document.querySelector('#mainAppContainer').style.display==='flex'");
    await evaluate("[...document.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='14').click()");
    assert.equal(await evaluate("document.querySelector('#modalNewTaskTimeMount details').open"), false, 'time picker starts collapsed');
    assert.equal(await evaluate("document.querySelector('#modalNewTaskTimeMount input').required"), false);
    await evaluate("document.querySelector('#modalNewTaskTimeMount details').open=true;document.querySelector('#modalNewTaskTimeMount [data-task-time=\"14:00\"]').click();document.querySelector('#modalNewTaskInput').value='Запланований виклик';document.querySelector('#modalAddNewTaskBtn').click()");
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].find(task=>task.text==='Запланований виклик').time"), '14:00');
    assert.equal(await evaluate("document.querySelector('#modalNewTaskTimeMount .task-time-input').value"), '', 'adding resets optional time');
    await evaluate("[...document.querySelectorAll('.task-modal-item')].find(row=>row.textContent.includes('Запланований виклик')).querySelector('.edit-task').click();document.querySelector('#taskEditorTimeMount .task-time-input').value='16:25';document.querySelector('#taskEditorTimeMount .task-time-input').dispatchEvent(new Event('input'));document.querySelector('#taskEditorSave').click()");
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].find(task=>task.text==='Запланований виклик').time"), '16:25');
    await evaluate("[...document.querySelectorAll('.task-modal-item')].find(row=>row.textContent.includes('Запланований виклик')).querySelector('.edit-task').click();document.querySelector('#taskEditorTimeMount details').open=true;document.querySelector('#taskEditorTimeMount .task-time-clear').click();document.querySelector('#taskEditorSave').click();document.querySelector('#modalNewTaskInput').value='Завдання без часу';document.querySelector('#modalAddNewTaskBtn').click()");
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].filter(task=>task.repairId==null).every(task=>!Object.hasOwn(task,'time'))"), true);

    const repairLink = await evaluate("document.querySelector('.task-repair-link').getAttribute('href')");
    assert.equal(repairLink, 'trackers.html?editRepair=' + linkedRepairId);
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.task-modal-checkbox').disabled"), false);
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.delete-task')"), null);
    assert.equal(await evaluate("document.querySelector('#modalDayTasksList').scrollWidth<=document.querySelector('#modalDayTasksList').clientWidth"), true, 'repair actions must fit on mobile');
    await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.move-task').click();document.querySelector('#taskCalendarDays [data-date=\"2026-10-15\"]').click();document.querySelector('#taskEditorTimeMount .task-time-input').value='14:30';document.querySelector('#taskEditorSave').click()");
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].some(task=>task.repairId===" + linkedRepairId + ")"), false);
    assert.equal(await evaluate("window.dayNotes['2026-10-15'].find(task=>task.repairId!=null).time"), '14:30');
    await navigate(repairLink);
    await waitFor("document.querySelector('#repairModalOverlay').classList.contains('active')");
    assert.equal(await evaluate("document.querySelector('#inputVehicle').value"), 'TEST-002');
    await evaluate("document.querySelector('#repairResultTab').click();document.querySelector('#inputRepairDate').value='15.10.2026';document.querySelector('#inputSpecialist').value='Артем';document.querySelector('#inputSolution').value='Трекер відремонтовано';document.querySelector('#btnSaveRepairModal').click()");
    assert.equal(await evaluate("Object.values(JSON.parse(localStorage.getItem('szvk_schedule_local_data')).dayNotes).flat().find(task=>task.repairId===" + linkedRepairId + ").done"), true);
    await navigate('index.html');
    await waitFor("document.querySelector('#mainAppContainer').style.display==='flex'");
    assert.equal(await evaluate("Object.values(window.dayNotes).flat().filter(task=>task.repairId===" + linkedRepairId + ").length"), 1);
    await evaluate("[...document.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='15').click()");
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.task-modal-checkbox').checked"), true);
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.completed-tasks').open"),false,'completed repair notes are collapsed too');
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.task-time-badge').textContent"), '14:30');
    assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), true);

    // Emulate a journal update in another tab while Work Hours stays open.
    await evaluate("{ const data=JSON.parse(localStorage.getItem('szvk_trackers_data'));const repair=data.repairs.find(item=>item.id===" + linkedRepairId + ");repair.repairDate='';localStorage.setItem('szvk_trackers_data',JSON.stringify(data));window.dispatchEvent(new StorageEvent('storage',{key:'szvk_trackers_data'})); }");
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.task-modal-checkbox').checked"), false);
    assert.equal(await evaluate("window.dayNotes['2026-10-15'].find(task=>task.repairId!=null).time"), '14:30');

    await evaluate("document.querySelector('#modalDayCloseX').click()");

    // Use controlled realtime snapshots to check cloud arrival order and fresh devices.
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__cloudListeners = {};
      window.__cloudWrites = [];
      window.__cloudData = JSON.parse(localStorage.getItem('szvk_mock_firestore') || 'null') || {
        schedule: JSON.parse(localStorage.getItem('szvk_schedule_local_data')),
        trackers: JSON.parse(localStorage.getItem('szvk_trackers_data') || localStorage.getItem('szvk_mock_cloud_trackers')),
        history: { items: [] }, users: { usersList: {} }
      };
      const cloudOnlyRepair = JSON.parse(localStorage.getItem('szvk_mock_cloud_only_repair') || 'null');
      if (cloudOnlyRepair && !window.__cloudData.trackers.repairs.some(repair => repair.id === cloudOnlyRepair.id)) window.__cloudData.trackers.repairs.push(cloudOnlyRepair);
      const readServer = () => JSON.parse(localStorage.getItem('szvk_mock_firestore') || 'null') || window.__cloudData;
      const persistCloud = () => localStorage.setItem('szvk_mock_firestore', JSON.stringify(window.__cloudData));
      window.__emitCloud = (name, data, fromCache = false, exists = true) => {
        if (exists && !fromCache) { window.__cloudData = readServer(); window.__cloudData[name] = structuredClone(data); persistCloud(); }
        window.__cloudListeners[name]?.({ exists, metadata: { fromCache }, data: () => structuredClone(data) });
      };
      window.addEventListener('storage', event => {
        if (event.key !== 'szvk_mock_firestore' || !event.newValue) return;
        const next = JSON.parse(event.newValue);
        const changed = Object.keys(next).filter(name => JSON.stringify(next[name]) !== JSON.stringify(window.__cloudData[name]));
        window.__cloudData = next;
        for (const name of changed) window.__cloudListeners[name]?.({ exists: true, metadata: { fromCache: false }, data: () => structuredClone(next[name]) });
      });
      const commitCloud = writes => {
        window.__cloudData = readServer();
        for (const { name, data, options } of writes) {
          window.__cloudWrites.push({ name, data: structuredClone(data), options });
          window.__cloudData[name] = options?.merge || options?.mergeFields ? { ...window.__cloudData[name], ...structuredClone(data) } : structuredClone(data);
        }
        persistCloud();
        for (const { name } of writes) setTimeout(() => window.__emitCloud(name, readServer()[name]), 0);
      };
      window.firebase = { apps: [{}], firestore: () => ({
        runTransaction: async callback => {
          if (window.__cloudOffline) throw new Error('Mock cloud offline');
          for (let attempt = 0; attempt < 20; attempt++) {
            const reads = new Map();
            const writes = [];
            const result = await callback({
              get: async doc => {
                const data = structuredClone(readServer()[doc.__name]);
                reads.set(doc.__name, JSON.stringify(data));
                return { exists: data != null, data: () => structuredClone(data) };
              },
              set: (doc, data, options) => writes.push({ name: doc.__name, data, options })
            });
            const latest = readServer();
            if ([...reads].some(([name, signature]) => signature !== JSON.stringify(latest[name]))) continue;
            if (writes.length) commitCloud(writes);
            return result;
          }
          throw new Error('Mock transaction conflicted');
        },
        collection: () => ({ doc: name => ({
        __name: name,
        onSnapshot: callback => {
          window.__cloudListeners[name] = callback;
          setTimeout(() => window.__emitCloud(name, readServer()[name]), name === 'trackers' ? 40 : 0);
          return () => { delete window.__cloudListeners[name]; };
        },
        get: async () => ({ exists: true, data: () => structuredClone(readServer()[name]) }),
        set: async (data, options) => commitCloud([{ name, data, options }])
      }) }) }) };
    ` });
    await evaluate("{const data=JSON.parse(localStorage.getItem('szvk_schedule_local_data'));data.dayNotes['2026-10-16']=[{id:'repair-555',repairId:555,text:'Перевізник · CLOUD-555',time:'11:45',done:false}];localStorage.setItem('szvk_schedule_local_data',JSON.stringify(data));localStorage.setItem('szvk_mock_cloud_only_repair',JSON.stringify({id:555,date:'14.10.2026',carrier:'Перевізник',vehicle:'CLOUD-555',workHoursTask:{dateKey:'2026-10-14'}}));}");
    await navigate('index.html');
    await waitFor("!!window.__cloudListeners.trackers && !!window.__cloudData.trackers");
    await waitFor("JSON.parse(localStorage.getItem('szvk_trackers_data')).repairs.some(repair=>repair.id===555)");
    assert.equal(await evaluate("window.dayNotes['2026-10-16'].find(task=>task.repairId===555).time"), '11:45', 'stale tracker cache must preserve cloud task transfers');
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].some(task=>task.repairId===555)"), false);
    await evaluate("localStorage.removeItem('szvk_mock_cloud_only_repair')");
    await evaluate("[...document.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='15').click()");
    await evaluate("{const data=structuredClone(window.__cloudData.trackers);const repair=data.repairs.find(item=>item.id===" + linkedRepairId + ");repair.repairDate='15.10.2026';repair.specialist='Артем';window.__cloudData.trackers=data;window.__emitCloud('trackers',data);}");
    assert.equal(await evaluate("window.dayNotes['2026-10-15'].find(task=>task.repairId===" + linkedRepairId + ").done"), true);
    await evaluate("window.__emitCloud('schedule',window.__cloudData.schedule)");
    assert.equal(await evaluate("window.dayNotes['2026-10-15'].find(task=>task.repairId===" + linkedRepairId + ").done"), true, 'late schedule snapshots cannot undo journal completion');
    assert.equal(await evaluate("document.querySelector('.task-repair-link').closest('.task-modal-item').querySelector('.task-time-badge').textContent"), '14:30');
    await evaluate("window.__emitCloud('trackers',null,true,false)");
    assert.equal(await evaluate("window.dayNotes['2026-10-15'].find(task=>task.repairId===" + linkedRepairId + ").time"), '14:30', 'empty offline cache must not remove linked notes');

    await evaluate("localStorage.setItem('szvk_mock_cloud_trackers',JSON.stringify(window.__cloudData.trackers));localStorage.removeItem('szvk_trackers_data')");
    await navigate(repairLink);
    await waitFor("document.querySelector('#repairModalOverlay').classList.contains('active')");
    assert.equal(await evaluate("document.querySelector('#inputVehicle').value"), 'TEST-002', 'deep link opens after cloud-only data arrives');
    assert.equal(await evaluate("Object.values(JSON.parse(localStorage.getItem('szvk_schedule_local_data')).dayNotes).flat().find(task=>task.repairId===" + linkedRepairId + ").time"), '14:30');

    await navigate('index.html');
    await waitFor("!!window.__cloudListeners.trackers");
    await evaluate("{const data=structuredClone(window.__cloudData.trackers);data.repairs.push({id:987654,date:'14.10.2026',carrier:'Хмарний перевізник',vehicle:'CLOUD-001',workHoursTask:{dateKey:'2026-10-14',author:'Артем'}});window.__emitCloud('trackers',data);}");
    assert.equal(await evaluate("window.dayNotes['2026-10-14'].find(task=>task.repairId===987654).text"), 'Хмарний перевізник · CLOUD-001');
    await evaluate("{const data=structuredClone(window.__cloudData.trackers);data.repairs=data.repairs.filter(repair=>repair.id!==987654);window.__emitCloud('trackers',data);}");
    assert.equal(await evaluate("Object.values(window.dayNotes).flat().some(task=>task.repairId===987654)"), false);
    assert.equal(await evaluate("Object.values(window.dayNotes).flat().some(task=>task.text==='Завдання без часу')"), true, 'remote repair deletion preserves manual notes');

    await navigate('trackers.html');
    await waitFor("!!window.__cloudListeners.trackers && !!document.querySelector('#recentRepairTableBody [data-repair-id]')");
    await evaluate("window.SZVKShared.saveAuthSession({username:'kostas',name:'Костянтин',role:'user'},true);const frame=document.createElement('iframe');frame.id='workHoursPeer';frame.src='index.html';frame.hidden=true;document.body.appendChild(frame)");
    await waitFor("document.querySelector('#workHoursPeer').contentWindow.__cloudListeners?.trackers && document.querySelector('#workHoursPeer').contentDocument.querySelector('#mainAppContainer')?.style.display==='flex'");
    const peer = expression => evaluate("(()=>{const w=document.querySelector('#workHoursPeer').contentWindow;const d=w.document;return (" + expression + ");})()");
    await evaluate("document.querySelector('#btnOpenAddModal').click();document.querySelector('#inputDate').value='01.09.2026';document.querySelector('#inputVehicle').value='CLOUD-TWO-WAY';document.querySelector('#inputCarrierSelect').value='Тестовий перевізник';document.querySelector('#inputCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('[data-issue]').click();document.querySelector('#btnSaveRepairModal').click()");
    await waitFor("window.__cloudData.trackers.repairs.some(repair=>repair.vehicle==='CLOUD-TWO-WAY')");
    const twoWayId = await evaluate("window.__cloudData.trackers.repairs.find(repair=>repair.vehicle==='CLOUD-TWO-WAY').id");
    await waitFor("document.querySelector('#workHoursPeer').contentWindow.dayNotes['2026-10-14']?.some(task=>task.repairId===" + twoWayId + ")");
    assert.equal(await evaluate("window.__cloudData.schedule.dayNotes['2026-10-14']?.find(task=>task.repairId===" + twoWayId + ")?.done"), false, 'new repair writes a real cloud note while Work Hours is already open');
    assert.equal(await peer("w.dayNotes['2026-10-14'].find(task=>task.repairId===" + twoWayId + ").author"), 'Артем');
    await peer("([...d.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='14').click(),d.querySelector('a[href=\"trackers.html?editRepair=" + twoWayId + "\"]').closest('.task-modal-item').querySelector('.move-task').click(),d.querySelector('#taskCalendarDays [data-date=\"2026-10-15\"]').click(),d.querySelector('#taskEditorTimeMount .task-time-input').value='17:10',d.querySelector('#taskEditorSave').click())");
    await waitFor("window.__cloudData.schedule.dayNotes['2026-10-15']?.some(task=>task.repairId===" + twoWayId + ")");
    await peer("(d.querySelector('#modalDayCloseX').click(),[...d.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='15').click(),d.querySelector('a[href=\"trackers.html?editRepair=" + twoWayId + "\"]').closest('.task-modal-item').querySelector('.task-modal-checkbox').click())");
    await waitFor("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").specialist==='Костянтин'");
    assert.equal(await evaluate("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").repairDate"), '15.10.2026', 'completion uses the transferred note day, not the current day');
    assert.equal(await evaluate("window.__cloudData.schedule.dayNotes['2026-10-15'].find(task=>task.repairId===" + twoWayId + ").done"), true);
    await evaluate("document.querySelector('#globalSearchInput').value='CLOUD-TWO-WAY';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'))");
    await waitFor("document.querySelector('#recentRepairTableBody [data-repair-id=\"" + twoWayId + "\"]') && !document.querySelector('#recentRepairTableBody [data-repair-id=\"" + twoWayId + "\"]').classList.contains('row-pending')");
    await peer("d.querySelector('a[href=\"trackers.html?editRepair=" + twoWayId + "\"]').closest('.task-modal-item').querySelector('.task-modal-checkbox').click()");
    await waitFor("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").repairDate===''");
    assert.equal(await evaluate("window.__cloudData.schedule.dayNotes['2026-10-15'].find(task=>task.repairId===" + twoWayId + ").time"), '17:10');
    await evaluate("window.finishRepair(" + twoWayId + ");document.querySelector('#inputRepairDate').value='16.10.2026';document.querySelector('#inputSolution').value='Відновлено GSM';document.querySelector('#btnSaveRepairModal').click()");
    await waitFor("document.querySelector('#workHoursPeer').contentWindow.dayNotes['2026-10-15']?.find(task=>task.repairId===" + twoWayId + ")?.done===true");
    assert.equal(await evaluate("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").repairDate"), '16.10.2026');
    await peer("d.querySelector('a[href=\"trackers.html?editRepair=" + twoWayId + "\"]').closest('.task-modal-item').querySelector('.task-modal-checkbox').click()");
    await waitFor("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").repairDate===''");
    await evaluate("window.__cloudOffline=true;document.querySelector('#workHoursPeer').contentWindow.__cloudOffline=true");
    await peer("d.querySelector('a[href=\"trackers.html?editRepair=" + twoWayId + "\"]').closest('.task-modal-item').querySelector('.task-modal-checkbox').click()");
    assert.equal(await peer("w.dayNotes['2026-10-15'].find(task=>task.repairId===" + twoWayId + ").done"), true);
    assert.equal(await evaluate("Object.keys(JSON.parse(localStorage.getItem('szvk_pending_repair_completions'))).length"), 1);
    await peer("w.__emitCloud('trackers',w.__cloudData.trackers,true)");
    assert.equal(await peer("w.dayNotes['2026-10-15'].find(task=>task.repairId===" + twoWayId + ").done"), true, 'offline completion survives a stale cached journal snapshot');
    await evaluate("window.__cloudOffline=false;const w=document.querySelector('#workHoursPeer').contentWindow;w.__cloudOffline=false;w.dispatchEvent(new w.Event('online'))");
    await waitFor("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").specialist==='Костянтин' && Object.keys(JSON.parse(localStorage.getItem('szvk_pending_repair_completions'))).length===0");
    assert.equal(await evaluate("window.__cloudData.trackers.repairs.find(repair=>repair.id===" + twoWayId + ").repairDate"), '15.10.2026');

    // Click the actual trash hit target; all data is isolated to this browser profile.
    const deleteIds = [900001, '900002', `legacy-'"<003>`];
    await evaluate(`{const data=structuredClone(window.__cloudData.trackers);${JSON.stringify(deleteIds)}.forEach((id,index)=>data.repairs.push({id,date:'14.10.2026',vehicle:'DELETE-'+index,carrier:'Тестовий перевізник',issue:'Тест видалення',workHoursTask:{dateKey:'2026-10-14',author:'Артем'}}));window.__emitCloud('trackers',data);document.querySelector('#globalSearchInput').value='DELETE-';document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'));window.confirm=()=>{throw new Error('Repair deletion must use the in-page dialog');};}`);
    await waitFor("document.querySelectorAll('#recentRepairTableBody [data-repair-id]').length===3");
    const clickTrash = async id => {
      const position = await evaluate(`(()=>{const row=[...document.querySelectorAll('#recentRepairTableBody [data-repair-id]')].find(row=>row.dataset.repairId===${JSON.stringify(String(id))});const button=row.querySelector('[data-repair-action="delete"]');button.scrollIntoView({block:'center',inline:'end'});const rect=button.getBoundingClientRect();const x=rect.left+rect.width/2,y=rect.top+rect.height/2;const hit=document.elementFromPoint(x,y);return {x,y,clickable:hit===button || button.contains(hit)};})()`);
      assert.equal(position.clickable,true,'trash button is visible and receives pointer clicks');
      await call('Input.dispatchMouseEvent',{type:'mousePressed',x:position.x,y:position.y,button:'left',clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:position.x,y:position.y,button:'left',clickCount:1});
      await waitFor("document.querySelector('#deleteRepairModal').classList.contains('active')");
    };
    await clickTrash(deleteIds[0]);
    await evaluate("document.querySelector('#cancelDeleteRepair').click()");
    assert.equal(await evaluate("window.__cloudData.trackers.repairs.some(repair=>repair.id===900001)"),true,'cancel keeps the repair');
    await clickTrash(deleteIds[0]);
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await evaluate("document.querySelector('#deleteRepairModal').classList.contains('active')"),false,'Escape cancels deletion');
    for (const id of deleteIds) {
      await clickTrash(id);
      await evaluate("document.querySelector('#confirmDeleteRepair').click()");
      await waitFor(`!window.__cloudData.trackers.repairs.some(repair=>String(repair.id)===${JSON.stringify(String(id))})`);
      await waitFor(`!Object.values(window.__cloudData.schedule.dayNotes).flat().some(task=>String(task.repairId)===${JSON.stringify(String(id))})`);
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('szvk_action_history_unified')).some(entry=>entry.type==='repair_delete' && String(entry.restoreData?.repair?.id)===${JSON.stringify(String(id))})`),true,'deletion preserves the record in undo history');
    }

    // A page left open across Kyiv midnight carries both local and cloud work.
    await peer("(w.__nativeDate=w.Date,w.Date=class extends w.__nativeDate{constructor(...args){super(...(args.length?args:['2026-10-17T12:00:00+03:00']));}static now(){return new w.__nativeDate('2026-10-17T12:00:00+03:00').getTime();}},w.dispatchEvent(new w.Event('focus'))) ");
    await waitFor("window.__cloudData.schedule.dayNotes['2026-10-17']?.some(task=>task.id==='test-task')");
    assert.equal(await peer("w.dayNotes['2026-10-17'].find(task=>task.id==='test-task').author"), 'Олександр');
    assert.equal(await peer("w.dayNotes['2026-10-17'].find(task=>task.id==='overdue-task').carriedFrom"), '2026-10-12');
    assert.equal(await evaluate("window.__cloudData.schedule.dayNotes['2026-10-15'].find(task=>task.repairId===" + twoWayId + ").done"), true, 'completed repair stays on its transferred day');
    await peer("w.dispatchEvent(new w.Event('focus'))");
    assert.equal(await peer("Object.values(w.dayNotes).flat().filter(task=>task.id==='test-task').length"), 1, 'repeated activation does not duplicate tasks');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('Browser checks passed: simplified navigation, view animations and reduced motion, repair tables/search, calendars, warehouse/references, optional time, cloud note creation, simultaneous Tracker Hub and Work Hours, bidirectional completion/reopening, transferred-day and clicking-account attribution, offline retry, responsive notes, history.');
    console.log('Screenshots: ' + artifacts);
  } finally {
    if (socket) socket.close();
    browser.kill();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
