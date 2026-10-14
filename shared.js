// Code shared by SZVK Work Hours and Tracker Hub.
(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: "AIzaSyD0HE2baTFHYCvm0d0cI_qNzLf6Ok7WMwA",
    authDomain: "szvk-work-hours-af5ed.firebaseapp.com",
    projectId: "szvk-work-hours-af5ed",
    storageBucket: "szvk-work-hours-af5ed.firebasestorage.app",
    messagingSenderId: "396427398813",
    appId: "1:396427398813:web:ac80bcd0ac4240d0c74e74"
  };

  function escapeHtml(str, apostropheEntity = "&#039;") {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, apostropheEntity);
  }

  function formatHistoryTime(timestamp) {
    if (!timestamp) return "";
    const d = new Date(timestamp);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${day}.${month}.${year} о ${hours}:${minutes}`;
  }

  function debounce(callback, delay = 150) {
    let timer = null;
    function schedule(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; callback.apply(this, args); }, delay);
    }
    schedule.cancel = () => { clearTimeout(timer); timer = null; };
    return schedule;
  }

  const htmlCache = new WeakMap();
  function setHtmlIfChanged(element, html) {
    if (htmlCache.get(element) === html) return false;
    element.innerHTML = html;
    htmlCache.set(element, html);
    return true;
  }

  const rowCache = new WeakMap();
  // Reuse unchanged rows and their controls; parse only new or changed records.
  function reconcileRows(container, items, buildHtml) {
    htmlCache.delete(container);
    let entries = rowCache.get(container);
    if (!entries) { entries = new Map(); rowCache.set(container, entries); }
    const keys = new Set();
    const elements = [];
    items.forEach((item, index) => {
      const key = String(item.id == null ? index : item.id);
      const signature = JSON.stringify(item);
      let entry = entries.get(key);
      if (!entry || entry.signature !== signature) {
        const parser = document.createElement('tbody');
        parser.innerHTML = buildHtml(item);
        entry = { signature, element: parser.firstElementChild };
        entries.set(key, entry);
      }
      keys.add(key);
      elements.push(entry.element);
    });
    const keep = new Set(elements);
    [...container.children].forEach(element => { if (!keep.has(element)) element.remove(); });
    elements.forEach((element, index) => {
      const current = container.children[index];
      if (current !== element) container.insertBefore(element, current || null);
    });
    for (const key of entries.keys()) if (!keys.has(key)) entries.delete(key);
  }

  function mountAccountMenu(options = {}) {
    const mount = document.getElementById('accountMount');
    if (!mount) return;
    mount.innerHTML = `
      <details class="account-menu" id="userProfileMenu">
        <summary class="account-summary" aria-label="Меню акаунта">
          <span class="account-avatar" id="headerAvatar">👤</span>
          <span id="headerName">Мій акаунт</span>
        </summary>
        <div class="account-panel">
          <div class="account-meta" id="accountUsername"></div>
          <div class="account-meta" id="headerStatus"></div>
          <div class="account-sync" role="status">
            <span class="status-dot" id="cloudSyncDot"></span>
            <span id="cloudSyncText">Дані збережено</span>
          </div>
          <button type="button" class="btn" id="${options.historyId || 'btnTabHistory'}">📜 Історія дій</button>
          ${options.backup
            ? '<button type="button" class="btn" id="btnOpenExportModal">💾 Бекап / Експорт</button>'
            : '<a class="btn" href="trackers.html?backup=1">💾 Бекап трекерів</a>'}
          ${options.admin ? '<button type="button" class="btn" id="btnOpenAdminPanel" style="display:none">Керування користувачами</button><button type="button" class="btn" id="btnOpenResetModal" style="display:none">Скинути підміни</button>' : ''}
          <button type="button" class="btn account-logout" id="btnLogoutBtn">Вийти з акаунта</button>
        </div>
      </details>`;
    initAccountMenu();
  }

  function logoutAccount() {
    localStorage.removeItem('szvk_auth_token');
    sessionStorage.removeItem('szvk_auth_token');
    localStorage.removeItem('szvk_internal_session');
    window.location.replace('index.html');
  }

  function updateAccount(user) {
    const values = {
      headerName: user ? (user.name || user.username || 'Користувач') : 'Мій акаунт',
      headerAvatar: user ? (user.name || user.username || 'К')[0].toUpperCase() : '👤',
      headerStatus: user && user.role === 'admin' ? 'Адміністратор' : 'Користувач',
      accountUsername: user && user.username ? '@' + user.username : ''
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    });
  }

  function initAccountMenu() {
    const menu = document.getElementById('userProfileMenu');
    if (!menu) return;
    document.addEventListener('click', event => {
      if (!menu.contains(event.target)) menu.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
    menu.querySelectorAll('button, a').forEach(element => {
      element.addEventListener('click', () => { menu.open = false; });
    });
  }

  function isValidDateKey(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1000 || year > 9999) return false;
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function needsInvoice(repair) {
    if (typeof repair.needInvoice === 'boolean') return repair.needInvoice;
    return ((repair.notes || '') + ' ' + (repair.solution || '')).toLowerCase().includes('рахунок');
  }

  function shiftInfo(dateKey, overrides = {}) {
    if (!isValidDateKey(dateKey)) return null;
    const [year, month, day] = dateKey.split('-').map(Number);
    const days = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(2026, 8, 1)) / 86400000);
    const cycleIndex = Math.floor(days / 3);
    const scheduledWorker = ((cycleIndex % 2) + 2) % 2 === 0 ? 'Артем' : 'Олександр';
    return {
      worker: overrides[dateKey] || scheduledWorker,
      scheduledWorker,
      isEdited: Boolean(overrides[dateKey]),
      shiftNum: ((days % 3) + 3) % 3 + 1,
      cycleIndex
    };
  }

  function kyivDateKey(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function repairDay(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    const key = match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : text;
    if (!isValidDateKey(key)) return NaN;
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  }

  function isRecentRepair(repair, todayKey = kyivDateKey()) {
    const today = repairDay(todayKey);
    return [repair.date, repair.repairDate].some(value => {
      const day = repairDay(value);
      return day >= today - 6 && day <= today;
    });
  }

  function calendarMonthDays(year, month) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1000 || year > 9999 || month < 0 || month > 11) return [];
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(Date.UTC(year, month, 1 - offset + index));
      return {
        dateKey: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
        day: date.getUTCDate(),
        inMonth: date.getUTCFullYear() === year && date.getUTCMonth() === month
      };
    });
  }

  function isValidTaskTime(value) {
    return value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function taskTimePickerHtml() {
    return `<details class="task-time-picker">
      <summary>◷ Час</summary>
      <div class="task-time-controls">
        <label>Час завдання <input type="time" class="task-time-input" step="60"></label>
        <button type="button" class="task-time-clear">Без часу</button>
        <div class="task-time-choices" aria-label="Швидкий вибір часу">
          ${['09:00', '10:00', '12:00', '14:00', '16:00', '18:00'].map(time => `<button type="button" data-task-time="${time}">${time}</button>`).join('')}
        </div>
      </div>
    </details>`;
  }

  function setTaskTimePicker(picker, value = '') {
    picker.querySelector('.task-time-input').value = value;
    picker.querySelector('summary').textContent = value ? '◷ ' + value : '◷ Час';
    picker.querySelectorAll('[data-task-time]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.taskTime === value)));
  }

  function initTaskTimePickers(container) {
    container.querySelectorAll('.task-time-picker').forEach(picker => {
      if (picker.dataset.initialized) return;
      picker.dataset.initialized = 'true';
      const input = picker.querySelector('.task-time-input');
      input.addEventListener('input', () => setTaskTimePicker(picker, input.value));
      picker.addEventListener('click', event => {
        const button = event.target.closest('[data-task-time], .task-time-clear');
        if (!button) return;
        setTaskTimePicker(picker, button.dataset.taskTime || '');
        picker.open = false;
      });
      setTaskTimePicker(picker, input.value);
    });
  }

  function isRepairPending(repair) {
    const date = String(repair.repairDate || '').trim();
    const specialist = String(repair.specialist || '').trim();
    return !date || date === '—' || date.toLowerCase().includes('процес') || !specialist || specialist === '—' || specialist === '\u200B';
  }

  function repairTaskDateKey(repair) {
    const metadata = repair.workHoursTask || {};
    if (isValidDateKey(metadata.dateKey)) return metadata.dateKey;
    const day = repairDay(repair.date);
    return Number.isFinite(day) ? new Date(day * 86400000).toISOString().slice(0, 10) : kyivDateKey();
  }

  // The journal owns repair text/status; a note owns its chosen day and time.
  // Reconcile by repair ID across every day so transfers never break completion.
  function reconcileRepairTasks(dayNotes, repairs, removeMissing = true) {
    if (!Array.isArray(repairs)) return false;
    const before = JSON.stringify(dayNotes);
    const byId = new Map(repairs.map(repair => [String(repair.id), repair]));
    const linked = new Set();
    for (const [dateKey, tasks] of Object.entries(dayNotes)) {
      if (!Array.isArray(tasks)) continue;
      const remaining = tasks.filter(task => {
        if (task.repairId == null) return true;
        const repairId = String(task.repairId);
        const repair = byId.get(repairId);
        if (!repair) return !removeMissing;
        if (linked.has(repairId)) return false;
        linked.add(repairId);
        task.text = [repair.carrier || 'Без перевізника', repair.vehicle || '—'].join(' · ');
        task.done = !isRepairPending(repair);
        return true;
      });
      if (remaining.length !== tasks.length) {
        if (remaining.length) dayNotes[dateKey] = remaining;
        else delete dayNotes[dateKey];
      }
    }
    for (const repair of repairs) {
      if (!repair.workHoursTask || linked.has(String(repair.id))) continue;
      const dateKey = repairTaskDateKey(repair);
      if (!Array.isArray(dayNotes[dateKey])) dayNotes[dateKey] = [];
      dayNotes[dateKey].push({
        id: 'repair-' + repair.id,
        repairId: repair.id,
        text: [repair.carrier || 'Без перевізника', repair.vehicle || '—'].join(' · '),
        done: !isRepairPending(repair),
        author: repair.workHoursTask.author || 'Користувач'
      });
      linked.add(String(repair.id));
    }
    return before !== JSON.stringify(dayNotes);
  }

  function syncLocalRepairTasks(repairs, removeMissing = true) {
    try {
      const key = 'szvk_schedule_local_data';
      const schedule = JSON.parse(localStorage.getItem(key) || '{}');
      if (!schedule.dayNotes) schedule.dayNotes = {};
      if (reconcileRepairTasks(schedule.dayNotes, repairs, removeMissing)) localStorage.setItem(key, JSON.stringify(schedule));
    } catch (error) {
      console.warn('Repair notes cache notice:', error);
    }
  }

  // Change the day, text and optional time without changing identity or completion.
  function updateTask(dayNotes, sourceDateKey, taskId, text, targetDateKey, time) {
    const cleanText = String(text || '').trim();
    if (!isValidDateKey(targetDateKey)) throw new Error('Оберіть коректну дату.');
    const source = dayNotes[sourceDateKey] || [];
    const index = source.findIndex(task => String(task.id) === String(taskId));
    if (index === -1) throw new Error('Це завдання вже перенесено або видалено. Оновіть список.');
    const previous = { ...source[index] };
    if (previous.repairId == null && (!cleanText || cleanText.length > 70)) throw new Error('Введіть завдання до 70 символів.');
    if (time !== undefined && !isValidTaskTime(time)) throw new Error('Оберіть коректний час.');
    const moved = sourceDateKey !== targetDateKey;
    if (moved && (dayNotes[targetDateKey] || []).some(task => String(task.id) === String(taskId))) {
      throw new Error('Це завдання вже є на вибраний день.');
    }
    const task = { ...previous, text: previous.repairId != null ? previous.text : cleanText };
    if (time !== undefined) {
      if (time) task.time = time;
      else delete task.time;
    }
    if (moved) {
      source.splice(index, 1);
      if (!source.length) delete dayNotes[sourceDateKey];
      if (!dayNotes[targetDateKey]) dayNotes[targetDateKey] = [];
      dayNotes[targetDateKey].push(task);
    } else {
      source[index] = task;
    }
    return { task, previous, moved, changed: moved || previous.text !== task.text || (previous.time || '') !== (task.time || '') };
  }

  function restoreTaskMove(dayNotes, restoreData) {
    const { fromDateKey, toDateKey, taskId, previous } = restoreData;
    const result = updateTask(dayNotes, toDateKey, taskId, previous.text, fromDateKey, previous.time || '');
    // Keep later completion changes while restoring the original text and day.
    return result.task;
  }

  function initTheme() {
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var urlTheme = urlParams.get('theme');
      if (urlTheme) {
        localStorage.setItem('szvk_ui_theme', urlTheme);
      }
      var saved = urlTheme || localStorage.getItem('szvk_ui_theme') || 'dark';
      var effective = saved;
      if (saved === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', effective);
    } catch (e) {}
  }

  function initThemeSwitcher(initialTheme) {
    const THEME_STORAGE_KEY = 'szvk_ui_theme';
    const themeButtons = document.querySelectorAll('.theme-btn');
    const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(themeChoice) {
      let effective = themeChoice;
      if (themeChoice === 'system') {
        effective = mediaDark.matches ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', effective);
      themeButtons.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-theme-val') === themeChoice);
      });
    }

    function setTheme(themeChoice) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, themeChoice);
      } catch (e) {}
      applyTheme(themeChoice);
    }

    themeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        setTheme(btn.getAttribute('data-theme-val'));
      });
    });

    try {
      mediaDark.addEventListener('change', () => {
        const current = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
        if (current === 'system') applyTheme('system');
      });
    } catch (e) {}

    const currentSavedTheme = initialTheme || localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
    applyTheme(currentSavedTheme);
  }

  function filterHistory(list, currentHistoryModule, currentHistoryTab, historySearchQuery) {
    return list.filter(item => {
      // 1. Module filter
      if (currentHistoryModule !== "all") {
        const itemMod = item.module || (item.type && (item.type.startsWith("repair_") || item.type.startsWith("inv_") || item.type.startsWith("bulk_")) ? "tracker_hub" : "schedule");
        if (itemMod !== currentHistoryModule) return false;
      }

      // 2. Tab filter
      if (currentHistoryTab !== "all") {
        let itemTab = item.tab;
        if (!itemTab) {
          if (item.type === "shift_swap") itemTab = "calendar";
          else if (item.type && item.type.startsWith("task_")) itemTab = "day_tasks";
          else if (item.type && item.type.startsWith("debt_")) itemTab = "notes";
          else if (item.type === "focus_edit") itemTab = "focus";
          else if (item.type && item.type.startsWith("repair_")) itemTab = "repairs";
          else if (item.type && (item.type.startsWith("inv_") || item.type.startsWith("bulk_"))) itemTab = "inventory";
          else itemTab = "admin";
        }
        if (itemTab !== currentHistoryTab) return false;
      }

      // 3. Search query
      if (historySearchQuery) {
        const q = historySearchQuery.toLowerCase();
        const matchDesc = (item.description || "").toLowerCase().includes(q);
        const matchDetails = (item.details || "").toLowerCase().includes(q);
        const matchUser = (item.user || "").toLowerCase().includes(q);
        const matchTime = formatHistoryTime(item.timestamp).toLowerCase().includes(q);
        if (!matchDesc && !matchDetails && !matchUser && !matchTime) return false;
      }
      return true;
    });
  }

  window.SZVKShared = Object.freeze({
    firebaseConfig,
    escapeHtml,
    formatHistoryTime,
    debounce,
    setHtmlIfChanged,
    reconcileRows,
    updateAccount,
    mountAccountMenu,
    logoutAccount,
    initAccountMenu,
    isValidDateKey,
    needsInvoice,
    shiftInfo,
    kyivDateKey,
    isRecentRepair,
    calendarMonthDays,
    isValidTaskTime,
    taskTimePickerHtml,
    setTaskTimePicker,
    initTaskTimePickers,
    isRepairPending,
    repairTaskDateKey,
    reconcileRepairTasks,
    syncLocalRepairTasks,
    updateTask,
    restoreTaskMove,
    initThemeSwitcher,
    filterHistory
  });
  initTheme();
})();
