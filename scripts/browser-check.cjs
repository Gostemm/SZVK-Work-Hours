// Browser regression checks use isolated local fixtures and block external traffic.
// Requires Node 22+ and Chrome (or SZVK_BROWSER_PATH pointing to a Chromium browser).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    const scheduleFixture = { overrides: {'2026-10-15':'Олександр'}, dayNotes: {'2026-10-14':[{id:'test-task',text:'Перевірити трекер та живлення у тестовому автобусі',author:'Олександр',done:false}]},monthlyDebts:{},monthFocusNotes:{} };
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-14T12:00:00+03:00'])); } static now() { return new Date('2026-10-14T12:00:00+03:00').getTime(); } };
      if (!localStorage.getItem('szvk_browser_fixture')) {
        localStorage.setItem('szvk_browser_fixture','1');
        localStorage.setItem('szvk_auth_token','isolated-test-token');
        localStorage.setItem('szvk_internal_session',JSON.stringify({username:'test',name:'Артем',role:'user'}));
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
    await call('Emulation.setDeviceMetricsOverride', { width:320,height:800,deviceScaleFactor:1,mobile:true });
    await navigate('trackers.html');
    await waitFor("typeof window.editRepair==='function'");
    assert.equal(await evaluate("document.querySelector('#tabBtnHistory').closest('.account-panel')!==null"), true);
    assert.equal(await evaluate("document.querySelector('.brand-badge')===null && document.querySelector('#atSearchInput')===null"), true);
    await evaluate("document.querySelector('#btnOpenAddModal').click()");
    assert.equal(await evaluate("!document.querySelector('#repairRequestPanel').hidden && document.querySelector('#repairResultPanel').hidden"),true);
    await evaluate(`document.querySelector('#inputVehicle').value='TEST-002';document.querySelector('#inputCarrierSelect').value='Тестовий перевізник';document.querySelector('#inputCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('[data-issue]').click();document.querySelector('#btnSaveRepairModal').click()`);
    let data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.repairs[0].carrier,'Тестовий перевізник');
    assert.equal(data.repairs[0].needInvoice,false);
    assert.equal(data.repairs[0].repairDate,'');
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
    await evaluate(`document.querySelector('#btnOpenAddModal').click();document.querySelector('#inputVehicle').value='TEST-003';document.querySelector('#inputCarrierSelect').value='__custom';document.querySelector('#inputCarrierSelect').dispatchEvent(new Event('change'));document.querySelector('#inputCarrierCustom').value='Новий тестовий перевізник';document.querySelector('#inputCarrierCustom').dispatchEvent(new Event('input'));document.querySelector('[data-issue]').click();document.querySelector('#btnSaveRepairModal').click()`);
    data = await evaluate("JSON.parse(localStorage.getItem('szvk_trackers_data'))");
    assert.equal(data.repairs[0].carrier,'Новий тестовий перевізник');
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
    assert.equal(await evaluate("document.querySelector('#btnTabHistory').closest('.account-panel')!==null"),true);
    await evaluate("[...document.querySelectorAll('.day-card')].find(card=>card.querySelector('.day-num')?.textContent==='14').click()");
    await waitFor("!!document.querySelector('.move-task')");
    assert.ok(await evaluate("document.querySelector('.task-modal-text').getBoundingClientRect().width>=180"),'mobile task text must retain width');
    const shot=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(artifacts,'work-hours-mobile.png'),Buffer.from(shot.data,'base64'));
    await evaluate("document.querySelector('.move-task').click();document.querySelector('#taskEditorShiftChoices [data-date=\"2026-10-15\"]').click()");
    assert.equal(await evaluate("document.querySelector('#taskEditorShift').textContent.includes('Олександр (підміна)')"),true);
    await evaluate("document.querySelector('#taskEditorSave').click()");
    const schedule = await evaluate("JSON.parse(localStorage.getItem('szvk_schedule_local_data'))");
    assert.equal(schedule.dayNotes['2026-10-14'],undefined);
    assert.equal(schedule.dayNotes['2026-10-15'][0].id,'test-task');
    assert.equal(schedule.dayNotes['2026-10-15'][0].author,'Олександр');
    assert.equal(schedule.dayNotes['2026-10-15'][0].done,false);
    await evaluate("document.querySelector('#taskEditorModal').classList.remove('active');document.querySelector('#modalDayCloseX').click();document.querySelector('#userProfileMenu').open=true;document.querySelector('#btnTabHistory').click()");
    assert.equal(await evaluate("document.querySelector('#historyView').style.display==='block' && !document.querySelector('#userProfileMenu').open"),true);
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('Browser checks passed: repair workflow, legacy values, custom specialist, invoice, command editing/copy, firmware persistence, responsive notes, profile history, shift transfer.');
    console.log('Screenshots: ' + artifacts);
  } finally {
    if (socket) socket.close();
    browser.kill();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
