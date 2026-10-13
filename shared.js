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

  // Change the day and/or text without changing identity, author, or completion.
  function updateTask(dayNotes, sourceDateKey, taskId, text, targetDateKey) {
    const cleanText = String(text || '').trim();
    if (!cleanText || cleanText.length > 70) throw new Error('Введіть завдання до 70 символів.');
    if (!isValidDateKey(targetDateKey)) throw new Error('Оберіть коректну дату.');
    const source = dayNotes[sourceDateKey] || [];
    const index = source.findIndex(task => String(task.id) === String(taskId));
    if (index === -1) throw new Error('Це завдання вже перенесено або видалено. Оновіть список.');
    const previous = { ...source[index] };
    const moved = sourceDateKey !== targetDateKey;
    if (moved && (dayNotes[targetDateKey] || []).some(task => String(task.id) === String(taskId))) {
      throw new Error('Це завдання вже є на вибраний день.');
    }
    const task = { ...previous, text: cleanText };
    if (moved) {
      source.splice(index, 1);
      if (!source.length) delete dayNotes[sourceDateKey];
      if (!dayNotes[targetDateKey]) dayNotes[targetDateKey] = [];
      dayNotes[targetDateKey].push(task);
    } else {
      source[index] = task;
    }
    return { task, previous, moved, changed: moved || previous.text !== cleanText };
  }

  function restoreTaskMove(dayNotes, restoreData) {
    const { fromDateKey, toDateKey, taskId, previous } = restoreData;
    const result = updateTask(dayNotes, toDateKey, taskId, previous.text, fromDateKey);
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
    updateTask,
    restoreTaskMove,
    initThemeSwitcher,
    filterHistory
  });
  initTheme();
})();
