// Code shared by SZVK Work Hours and Tracker Hub.
(function () {
  'use strict';

  // Increment only when all existing browser sessions must sign in again.
  // This is a client migration marker, not server-side authentication.
  const AUTH_SESSION_VERSION = '2026-10-15-1';

  function clearAuthSession() {
    localStorage.removeItem('szvk_auth_token');
    sessionStorage.removeItem('szvk_auth_token');
    localStorage.removeItem('szvk_internal_session');
    localStorage.removeItem('szvk_remembered_credentials');
  }

  function readAuthSession() {
    try {
      const token = localStorage.getItem('szvk_auth_token') || sessionStorage.getItem('szvk_auth_token');
      const user = JSON.parse(localStorage.getItem('szvk_internal_session') || 'null');
      if (token && user && user.sessionVersion === AUTH_SESSION_VERSION &&
          typeof user.username === 'string' && user.username.trim() && user.active === true &&
          ['admin', 'editor', 'user'].includes(user.role)) return user;
    } catch (error) {}
    clearAuthSession();
    return null;
  }

  function saveAuthSession(user, remember) {
    const session = {
      username: user.username, name: user.name, role: user.role, active: true,
      sessionVersion: AUTH_SESSION_VERSION
    };
    clearAuthSession();
    localStorage.setItem('szvk_internal_session', JSON.stringify(session));
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem('szvk_auth_token', 'local_session_' + Date.now());
    return session;
  }

  async function fetchLoginAccounts(usersDoc) {
    if (!usersDoc) throw new Error('Для входу потрібне з’єднання з базою. Перевірте інтернет і оновіть сторінку.');
    // Cached hashes can still contain a previous password after it was changed.
    const snapshot = await usersDoc.get({ source: 'server' });
    if (!snapshot.exists || snapshot.metadata && (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites)) {
      throw new Error('Не вдалося перевірити актуальні дані акаунтів. Спробуйте ще раз онлайн.');
    }
    const accounts = snapshot.data();
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
      throw new Error('Налаштування акаунтів недоступні. Зверніться до адміністратора.');
    }
    return accounts;
  }

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

  const modalAnimations = new WeakMap();
  const activeModalAnimations = new Set();
  const modalMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  modalMotionPreference.addEventListener?.('change', event => {
    if (event.matches) [...activeModalAnimations].forEach(state => state.cleanup());
  });
  function animateModal(modal, opening) {
    if (!modal) return;
    const running = modalAnimations.get(modal);
    if (running && running.opening === opening) return running.finished;
    const visible = modal.classList.contains('active') || !!running;
    if (!running && visible === opening) return;
    const motion = typeof modal.animate === 'function' && !modalMotionPreference.matches;
    const box = motion ? modal.querySelector('.modal-box') : null;
    const startOpacity = visible && motion ? window.getComputedStyle(modal).opacity : '0';
    const boxStyle = visible && box ? window.getComputedStyle(box) : null;
    const startScale = boxStyle && boxStyle.scale !== 'none' ? boxStyle.scale : '1';
    const startTranslate = boxStyle && boxStyle.translate !== 'none' ? boxStyle.translate : '0 0';
    if (running) running.cleanup();
    if (opening) modal.classList.add('active');
    else modal.classList.remove('active');
    modal.inert = !opening;
    if (!motion || !box || (!opening && !visible)) return;

    // Keep the actual dialog rendered until its exit finishes, in every browser.
    const originalDisplay = modal.style.display;
    modal.style.display = 'flex';
    if (!opening) modal.classList.add('is-closing');
    const timing = {
      duration: opening ? 240 : 260,
      easing: opening ? 'cubic-bezier(0.2, 0.65, 0.3, 1)' : 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'both'
    };
    const fade = modal.animate([{ opacity: startOpacity }, { opacity: opening ? 1 : 0 }], timing);
    const movement = box.animate([
      { scale: visible ? startScale : '0.99', translate: startTranslate },
      { scale: opening ? '1' : '0.98', translate: opening ? '0 0' : '0 8px' }
    ], timing);
    const state = {
      opening,
      cleanup() {
        activeModalAnimations.delete(state);
        fade.cancel();
        movement.cancel();
        if (modalAnimations.get(modal) === state) {
          modalAnimations.delete(modal);
          modal.classList.remove('is-closing');
          modal.style.display = originalDisplay;
        }
      }
    };
    modalAnimations.set(modal, state);
    activeModalAnimations.add(state);
    const finish = () => { if (modalAnimations.get(modal) === state) state.cleanup(); };
    state.finished = fade.finished.then(finish, finish);
    return state.finished;
  }

  function openModal(modal) { return animateModal(modal, true); }
  function closeModal(modal) { return animateModal(modal, false); }

  const viewTransitions = new WeakMap();
  function transitionViews(previousView, nextView, update, { retainPrevious = false } = {}) {
    const host = nextView.parentElement;
    const running = viewTransitions.get(host);
    const startHeight = host.getBoundingClientRect().height;
    const previousBounds = previousView && previousView.getBoundingClientRect();
    const hostBounds = host.getBoundingClientRect();
    const animate = previousBounds && previousBounds.height > 0 &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof nextView.animate === 'function';
    const retained = retainPrevious && previousView !== nextView;
    const snapshot = animate ? (retained ? previousView : previousView.cloneNode(true)) : null;
    const previousDisplay = animate ? window.getComputedStyle(previousView).display : '';
    if (running) running.cleanup();

    // The application state and controls update immediately, including during rapid navigation.
    update();
    if (!snapshot) return;
    const endHeight = host.getBoundingClientRect().height;
    const originalStyle = snapshot.getAttribute('style');
    const originalInert = snapshot.inert;
    const originalAriaHidden = snapshot.getAttribute('aria-hidden');
    if (!retained) {
      snapshot.removeAttribute('id');
      snapshot.querySelectorAll('[id], [name], [autofocus]').forEach(element => {
        element.removeAttribute('id');
        element.removeAttribute('name');
        element.removeAttribute('autofocus');
      });
      // A visual copy inside a form must never participate in submission or validation.
      snapshot.querySelectorAll('input, select, textarea, button, fieldset').forEach(control => {
        control.disabled = true;
        control.removeAttribute('required');
      });
    }
    snapshot.inert = true;
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.classList.add('view-transition-outgoing');
    Object.assign(snapshot.style, {
      position: 'absolute', top: (previousBounds.top - hostBounds.top + host.scrollTop) + 'px',
      left: (previousBounds.left - hostBounds.left + host.scrollLeft) + 'px',
      width: previousBounds.width + 'px', height: previousBounds.height + 'px',
      margin: '0', pointerEvents: 'none', zIndex: '5'
    });
    if (retained) snapshot.style.display = previousDisplay;
    host.classList.add('view-transition-host');
    if (!retained) host.appendChild(snapshot);

    const timing = { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
    const incoming = nextView.animate([{ opacity: retained ? 0.001 : 0 }, { opacity: 1 }], timing);
    const outgoing = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: 220, fill: 'forwards' });
    const animations = [incoming, outgoing];
    if (Math.abs(startHeight - endHeight) > 1) {
      animations.push(host.animate([{ height: startHeight + 'px' }, { height: endHeight + 'px' }], timing));
    }
    let prepareFrame = null;
    let prepareTimer = null;
    const state = {
      cleanup() {
        if (prepareFrame !== null) window.cancelAnimationFrame(prepareFrame);
        if (prepareTimer !== null) window.clearTimeout(prepareTimer);
        animations.forEach(animation => animation.cancel());
        if (retained) {
          if (originalStyle === null) snapshot.removeAttribute('style');
          else snapshot.setAttribute('style', originalStyle);
          snapshot.inert = originalInert;
          if (originalAriaHidden === null) snapshot.removeAttribute('aria-hidden');
          else snapshot.setAttribute('aria-hidden', originalAriaHidden);
          snapshot.classList.remove('view-transition-outgoing');
        } else snapshot.remove();
        if (viewTransitions.get(host) === state) {
          viewTransitions.delete(host);
          host.classList.remove('view-transition-host');
        }
      }
    };
    viewTransitions.set(host, state);
    const finish = () => { if (viewTransitions.get(host) === state) state.cleanup(); };
    incoming.finished.then(finish, finish);
    if (retained) {
      // Prepare and paint a large destination while the previous view still covers it.
      animations.forEach(animation => animation.pause());
      const play = () => {
        if (viewTransitions.get(host) !== state) return;
        if (prepareFrame !== null) window.cancelAnimationFrame(prepareFrame);
        if (prepareTimer !== null) window.clearTimeout(prepareTimer);
        prepareFrame = prepareTimer = null;
        animations.forEach(animation => animation.play());
      };
      prepareFrame = window.requestAnimationFrame(() => { prepareFrame = window.requestAnimationFrame(play); });
      prepareTimer = window.setTimeout(play, 100);
    }
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

  function mountUsefulLinks() {
    const themeSwitcher = document.getElementById('themeSwitchGroup');
    if (!themeSwitcher) return;
    let menu = document.querySelector('.useful-links');
    if (!menu) {
      menu = document.createElement('details');
      menu.className = 'useful-links';
      menu.innerHTML = `
        <summary><span aria-hidden="true">🔗</span> Корисні посилання</summary>
        <div class="useful-links-panel" role="group" aria-label="Корисні сервіси">
          <a class="useful-link" href="http://192.168.88.13:6613/" target="_blank" rel="noopener noreferrer" aria-label="CardChecker (відкриється в новій вкладці)">
            <img class="useful-link-logo" src="assets/cardchecker.svg" width="56" height="56" alt="" decoding="async">
            <span class="useful-link-copy"><strong>CardChecker</strong><span>Файна карта · Тернопіль</span></span>
            <span class="useful-link-arrow" aria-hidden="true">↗</span>
          </a>
          <a class="useful-link" href="https://t.me/Terminal_SZVK_bot" target="_blank" rel="noopener noreferrer" aria-label="Перенесення терміналів (відкриється в новій вкладці)">
            <img class="useful-link-logo" src="assets/terminal-transfer.jpg" width="56" height="56" alt="" decoding="async">
            <span class="useful-link-copy"><strong>Перенесення терміналів</strong><span>Telegram-бот</span></span>
            <span class="useful-link-arrow" aria-hidden="true">↗</span>
          </a>
          <a class="useful-link" href="https://navisoft.com.ua" target="_blank" rel="noopener noreferrer" aria-label="Navisoft (відкриється в новій вкладці)">
            <img class="useful-link-logo" src="assets/navisoft.png" width="56" height="56" alt="" decoding="async">
            <span class="useful-link-copy"><strong>Navisoft</strong><span>navisoft.com.ua</span></span>
            <span class="useful-link-arrow" aria-hidden="true">↗</span>
          </a>
        </div>`;
    }
    themeSwitcher.before(menu);
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
          ${options.admin ? '<button type="button" class="btn" id="btnOpenAdminPanel" style="display:none">Керування користувачами</button>' : ''}
          <button type="button" class="btn account-logout" id="btnLogoutBtn">Вийти з акаунта</button>
        </div>
      </details>`;
    mountUsefulLinks();
    initAccountMenu();
  }

  function logoutAccount() {
    clearAuthSession();
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
    [document.getElementById('userProfileMenu'), ...document.querySelectorAll('.useful-links')].forEach(initHeaderMenu);
  }

  const headerMenus = new WeakSet();
  function initHeaderMenu(menu) {
    if (!menu || headerMenus.has(menu)) return;
    headerMenus.add(menu);
    const summary = menu.querySelector('summary');
    const panel = menu.querySelector('.account-panel, .useful-links-panel');
    let targetOpen = menu.open;
    let animation = null;
    summary.setAttribute('aria-expanded', String(targetOpen));
    panel.inert = !targetOpen;
    const setOpen = opening => {
      if (targetOpen === opening && ((!animation && menu.open === opening) || animation)) return;
      const visible = menu.open;
      const style = visible ? window.getComputedStyle(panel) : null;
      const opacity = style ? style.opacity : '0';
      const translate = style && style.translate !== 'none' ? style.translate : '0 -4px';
      if (animation) { animation.cancel(); animation = null; }
      targetOpen = opening;
      summary.setAttribute('aria-expanded', String(opening));
      panel.inert = !opening;
      menu.classList.toggle('header-menu-closing', !opening);
      if (modalMotionPreference.matches || typeof panel.animate !== 'function') {
        menu.open = opening;
        menu.classList.remove('header-menu-closing');
        return;
      }
      // Keep native details open throughout the exit; one animation owns the panel.
      menu.open = true;
      const current = panel.animate([
        { opacity, translate },
        { opacity: opening ? 1 : 0, translate: opening ? '0 0' : '0 -4px' }
      ], { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'both' });
      animation = current;
      current.finished.then(() => {
        if (animation !== current) return;
        menu.open = targetOpen;
        menu.classList.remove('header-menu-closing');
        animation = null;
        current.cancel();
      }, () => {});
    };
    summary.addEventListener('click', event => {
      event.preventDefault();
      setOpen(animation ? !targetOpen : !menu.open);
    });
    menu.addEventListener('toggle', () => {
      if (!menu.open && animation) { animation.cancel(); animation = null; }
      if (!animation) {
        targetOpen = menu.open;
        panel.inert = !targetOpen;
        summary.setAttribute('aria-expanded', String(targetOpen));
        menu.classList.remove('header-menu-closing');
      }
    });
    modalMotionPreference.addEventListener?.('change', event => {
      if (!event.matches || !animation) return;
      const current = animation;
      animation = null;
      current.cancel();
      menu.open = targetOpen;
      panel.inert = !targetOpen;
      menu.classList.remove('header-menu-closing');
    });
    document.addEventListener('click', event => {
      if (!menu.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open && targetOpen) {
        event.preventDefault();
        setOpen(false);
        summary.focus();
      }
    });
    menu.querySelectorAll('button, a').forEach(element => {
      element.addEventListener('click', () => setOpen(false));
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

  // The live work list spans all months, independently of the calendar being viewed.
  function activeTaskGroups(dayNotes, todayKey = kyivDateKey()) {
    const active = [], planned = [];
    for (const [dateKey, tasks] of Object.entries(dayNotes || {})) {
      if (!isValidDateKey(dateKey) || !Array.isArray(tasks)) continue;
      for (const task of tasks) {
        if (!task || task.done) continue;
        (dateKey <= todayKey ? active : planned).push({ dateKey, task });
      }
    }
    const bySchedule = (a, b) => a.dateKey.localeCompare(b.dateKey) ||
      (a.task.time || '24:00').localeCompare(b.task.time || '24:00');
    const origin = entry => isValidDateKey(entry.task.carriedFrom) ? entry.task.carriedFrom : entry.dateKey;
    active.sort((a, b) => origin(a).localeCompare(origin(b)) || bySchedule(a, b));
    planned.sort(bySchedule);
    return { active, planned };
  }

  // Every calendar day has an active shift. Catch up overdue work directly to
  // the current Kyiv day, keeping completed work on its actual scheduled day.
  function carryForwardTasks(dayNotes, todayKey = kyivDateKey(), includeRepairs = true) {
    if (!isValidDateKey(todayKey)) throw new Error('Оберіть коректний активний день.');
    let changed = false;
    for (const dateKey of Object.keys(dayNotes).sort()) {
      if (!isValidDateKey(dateKey) || dateKey >= todayKey || !Array.isArray(dayNotes[dateKey])) continue;
      const remaining = [];
      for (const task of dayNotes[dateKey]) {
        if (!task || task.done || (!includeRepairs && task.repairId != null)) { remaining.push(task); continue; }
        if (!Array.isArray(dayNotes[todayKey])) dayNotes[todayKey] = [];
        if (!task.carriedFrom) task.carriedFrom = dateKey;
        dayNotes[todayKey].push(task);
        changed = true;
      }
      if (remaining.length !== dayNotes[dateKey].length) {
        if (remaining.length) dayNotes[dateKey] = remaining;
        else delete dayNotes[dateKey];
      }
    }
    return changed;
  }

  async function rollOverTasksInCloud(db, trackerDoc, scheduleDoc, todayKey = kyivDateKey()) {
    if (!isValidDateKey(todayKey)) throw new Error('Оберіть коректний активний день.');
    return db.runTransaction(async transaction => {
      const trackerSnapshot = await transaction.get(trackerDoc);
      const scheduleSnapshot = await transaction.get(scheduleDoc);
      if (!scheduleSnapshot.exists) return false;
      const dayNotes = scheduleSnapshot.data().dayNotes || {};
      const reconciled = trackerSnapshot.exists
        ? reconcileRepairTasks(dayNotes, trackerSnapshot.data().repairs || [])
        : false;
      const carried = carryForwardTasks(dayNotes, todayKey);
      if (reconciled || carried) transaction.set(scheduleDoc, { dayNotes, updatedAt: Date.now() }, { mergeFields: ['dayNotes', 'updatedAt'] });
      return reconciled || carried;
    });
  }

  function setRepairCompletion(repairs, repairId, done, dateKey, user) {
    const repair = repairs.find(item => String(item.id) === String(repairId));
    if (!repair) {
      const error = new Error('Запис ремонту вже видалено. Оновіть список.');
      error.code = 'repair_missing';
      throw error;
    }
    if (!isValidDateKey(dateKey)) throw new Error('Оберіть коректний день виконання.');
    const specialist = String(user && (user.name || user.username) || '').trim();
    if (done && !specialist) throw new Error('Увійдіть в акаунт, щоб завершити ремонт.');
    const previous = JSON.parse(JSON.stringify(repair));
    if (done === !isRepairPending(repair)) return { repair, previous, changed: false };
    const [year, month, day] = dateKey.split('-');
    repair.repairDate = done ? `${day}.${month}.${year}` : '';
    repair.specialist = done ? specialist : '';
    if (!repair.workHoursTask) repair.workHoursTask = { dateKey };
    if (done) repair.workHoursTask.completedBy = user.username || specialist;
    else delete repair.workHoursTask.completedBy;
    return { repair, previous, changed: true };
  }

  // Apply only the locally edited repair fields to the latest journal.
  // A new request or inventory save must not undo another user's completion.
  function mergeRepairChanges(previous, next, current) {
    const previousById = new Map(previous.map(item => [String(item.id), item]));
    const nextById = new Map(next.map(item => [String(item.id), item]));
    const currentById = new Map(current.map(item => [String(item.id), item]));
    const result = [];
    for (const item of next) {
      const key = String(item.id);
      const before = previousById.get(key);
      const remote = currentById.get(key);
      if (!before) { result.push({ ...item }); continue; }
      if (!remote) continue;
      const merged = { ...remote };
      for (const field of new Set([...Object.keys(before), ...Object.keys(item)])) {
        if (JSON.stringify(before[field]) === JSON.stringify(item[field])) continue;
        if (Object.prototype.hasOwnProperty.call(item, field)) merged[field] = item[field];
        else delete merged[field];
      }
      result.push(merged);
    }
    for (const item of current) {
      const key = String(item.id);
      if (!nextById.has(key) && !previousById.has(key)) result.push({ ...item });
    }
    return result;
  }

  async function saveTrackerDataAndNotes(db, trackerDoc, scheduleDoc, payload, previous) {
    return db.runTransaction(async transaction => {
      const trackerSnapshot = await transaction.get(trackerDoc);
      const scheduleSnapshot = await transaction.get(scheduleDoc);
      const remote = trackerSnapshot.exists ? trackerSnapshot.data() : {};
      const repairs = trackerSnapshot.exists
        ? mergeRepairChanges(previous.repairs || [], payload.repairs, remote.repairs || [])
        : payload.repairs;
      const update = { repairs, updatedAt: payload.updatedAt };
      for (const field of ['inventory', 'atCommands', 'primaryCommands', 'firmwareVersions']) {
        if (!trackerSnapshot.exists || JSON.stringify(previous[field]) !== JSON.stringify(payload[field])) update[field] = payload[field];
      }
      const schedule = scheduleSnapshot.exists ? scheduleSnapshot.data() : {};
      const dayNotes = schedule.dayNotes || {};
      const changed = reconcileRepairTasks(dayNotes, repairs);
      transaction.set(trackerDoc, update, { merge: true });
      if (changed) transaction.set(scheduleDoc, { dayNotes, updatedAt: payload.updatedAt }, { mergeFields: ['dayNotes', 'updatedAt'] });
      return { repairs, dayNotes };
    });
  }

  async function syncRepairTasksToCloud(db, trackerDoc, scheduleDoc) {
    return db.runTransaction(async transaction => {
      const trackerSnapshot = await transaction.get(trackerDoc);
      const scheduleSnapshot = await transaction.get(scheduleDoc);
      if (!trackerSnapshot.exists) return;
      const repairs = trackerSnapshot.data().repairs || [];
      const dayNotes = scheduleSnapshot.exists ? scheduleSnapshot.data().dayNotes || {} : {};
      if (reconcileRepairTasks(dayNotes, repairs)) transaction.set(scheduleDoc, { dayNotes, updatedAt: Date.now() }, { mergeFields: ['dayNotes', 'updatedAt'] });
    });
  }

  async function completeRepairTaskInCloud(db, trackerDoc, scheduleDoc, request) {
    return db.runTransaction(async transaction => {
      const trackerSnapshot = await transaction.get(trackerDoc);
      const scheduleSnapshot = await transaction.get(scheduleDoc);
      const repairs = trackerSnapshot.exists ? trackerSnapshot.data().repairs || [] : [];
      const result = setRepairCompletion(repairs, request.repairId, request.done, request.dateKey, request.user);
      const dayNotes = scheduleSnapshot.exists ? scheduleSnapshot.data().dayNotes || {} : {};
      const notesChanged = reconcileRepairTasks(dayNotes, repairs);
      if (result.changed) transaction.set(trackerDoc, { repairs, updatedAt: Date.now() }, { merge: true });
      if (notesChanged) transaction.set(scheduleDoc, { dayNotes, updatedAt: Date.now() }, { mergeFields: ['dayNotes', 'updatedAt'] });
      return result;
    });
  }

  const pendingRepairKey = 'szvk_pending_repair_completions';
  function pendingRepairCompletions() {
    try { return JSON.parse(localStorage.getItem(pendingRepairKey) || '{}'); }
    catch (error) { return {}; }
  }

  function queueRepairCompletion(request) {
    const pending = pendingRepairCompletions();
    pending[String(request.repairId)] = { ...request, requestId: Date.now() + '-' + Math.random().toString(36).slice(2) };
    localStorage.setItem(pendingRepairKey, JSON.stringify(pending));
  }

  function applyPendingRepairCompletions(repairs) {
    if (!Array.isArray(repairs)) return;
    for (const request of Object.values(pendingRepairCompletions())) {
      if (repairs.some(repair => String(repair.id) === String(request.repairId))) setRepairCompletion(repairs, request.repairId, request.done, request.dateKey, request.user);
    }
  }

  let repairFlush = null;
  function flushRepairCompletions(db, trackerDoc, scheduleDoc) {
    if (repairFlush) return repairFlush;
    repairFlush = (async () => {
      const results = [];
      while (true) {
        const requests = Object.values(pendingRepairCompletions());
        if (!requests.length) return results;
        for (const request of requests) {
          let result;
          try { result = await completeRepairTaskInCloud(db, trackerDoc, scheduleDoc, request); }
          catch (error) { if (error.code !== 'repair_missing') throw error; }
          const pending = pendingRepairCompletions();
          if (pending[String(request.repairId)]?.requestId === request.requestId) {
            delete pending[String(request.repairId)];
            localStorage.setItem(pendingRepairKey, JSON.stringify(pending));
          }
          if (result) results.push(result);
        }
      }
    })().finally(() => { repairFlush = null; });
    return repairFlush;
  }

  // Change the day, text and optional time without changing identity or completion.
  function updateTask(dayNotes, sourceDateKey, taskId, text, targetDateKey, time) {
    const cleanText = String(text || '').trim();
    if (!isValidDateKey(targetDateKey)) throw new Error('Оберіть коректну дату.');
    const source = dayNotes[sourceDateKey] || [];
    const index = source.findIndex(task => String(task.id) === String(taskId));
    if (index === -1) throw new Error('Це завдання вже перенесено або видалено. Оновіть список.');
    const previous = { ...source[index] };
    if (previous.repairId == null && (!cleanText || cleanText.length > 140)) throw new Error('Введіть завдання до 140 символів.');
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

  let moduleNavigation = null;

  function navigateModule(href) {
    if (!moduleNavigation || !moduleNavigation.navigate(href)) window.location.assign(href);
  }

  // Called at the start of <body>, before the blocking Firebase scripts. This lets
  // the destination paint the same loading screen while its application loads.
  function initModuleTransition() {
    if (moduleNavigation) return;
    const modules = [
      { url: new URL('index.html', window.location.href), icon: '⏱️', name: 'Work Hours' },
      { url: new URL('trackers.html', window.location.href), icon: '🛰️', name: 'Tracker Hub' }
    ];
    const current = modules.find(item => item.url.pathname === window.location.pathname) ||
      (window.location.pathname.endsWith('/') ? modules[0] : null);
    if (!current) return;

    const storageKey = 'szvk_module_transition';
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let overlay = null;
    let navigationTimer = null;
    let cleanupTimer = null;
    let previousFocus = null;

    function reset() {
      clearTimeout(navigationTimer);
      clearTimeout(cleanupTimer);
      overlay?.remove();
      overlay = null;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      previousFocus = null;
    }

    function mount(from, to, arriving) {
      overlay = document.createElement('div');
      overlay.className = 'module-transition' + (arriving ? ' module-transition--arriving' : '');
      overlay.style.setProperty('--module-turn', to === modules[1] ? '32deg' : '-32deg');
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');
      overlay.setAttribute('aria-label', 'Перехід до ' + to.name);
      overlay.tabIndex = -1;
      overlay.innerHTML = `
        <div class="module-transition-content" aria-hidden="true">
          <div class="module-transition-mark">
            <span class="module-transition-orbit"></span>
            <span class="module-transition-icon module-transition-from">${from.icon}</span>
            <span class="module-transition-icon module-transition-to">${to.icon}</span>
          </div>
          <div class="module-transition-label">
            <span class="module-transition-from">${from.name}</span>
            <span class="module-transition-to">${to.name}</span>
          </div>
          <div class="module-transition-progress"><span></span></div>
        </div>`;
      document.body.appendChild(overlay);
      if (!arriving) {
        previousFocus = document.activeElement;
        overlay.focus({ preventScroll: true });
      }
    }

    function destination(href) {
      const url = new URL(href, window.location.href);
      const target = modules.find(item => item !== current && item.url.origin === url.origin && item.url.pathname === url.pathname);
      return target ? { url, target } : null;
    }

    moduleNavigation = {
      navigate(href) {
        const next = destination(href);
        if (!next) return false;
        if (overlay) return true;
        mount(current, next.target, false);
        const leave = () => {
          try {
            sessionStorage.setItem(storageKey, JSON.stringify({
              from: current.url.pathname, href: next.url.href, createdAt: Date.now()
            }));
          } catch (error) { /* Navigation still works when browser storage is unavailable. */ }
          window.location.assign(next.url.href);
          // Recover if a beforeunload handler cancels navigation.
          cleanupTimer = setTimeout(reset, 10000);
        };
        navigationTimer = setTimeout(leave, motion.matches ? 0 : 520);
        return true;
      }
    };

    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self') || !destination(link.href)) return;
      event.preventDefault();
      moduleNavigation.navigate(link.href);
    });
    document.addEventListener('keydown', event => {
      if (overlay && event.key === 'Tab') event.preventDefault();
    });
    window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
    window.addEventListener('pagehide', () => {
      clearTimeout(navigationTimer);
      clearTimeout(cleanupTimer);
    });

    try {
      const pending = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      sessionStorage.removeItem(storageKey);
      const from = pending && modules.find(item => item.url.pathname === pending.from);
      const age = pending && Date.now() - pending.createdAt;
      if (from && from !== current && pending.href === window.location.href && age >= 0 && age < 15000) {
        mount(from, current, true);
        const reveal = () => {
          if (!overlay) return;
          clearTimeout(cleanupTimer);
          overlay.classList.add('module-transition--ready');
          cleanupTimer = setTimeout(reset, motion.matches ? 0 : 200);
        };
        // All DOMContentLoaded application handlers finish before the next paint.
        document.addEventListener('DOMContentLoaded', () => {
          requestAnimationFrame(() => requestAnimationFrame(reveal));
        }, { once: true });
        cleanupTimer = setTimeout(reveal, 12000);
      }
    } catch (error) { /* A direct visit never depends on stored transition state. */ }
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
    authSessionVersion: AUTH_SESSION_VERSION,
    clearAuthSession,
    readAuthSession,
    saveAuthSession,
    fetchLoginAccounts,
    firebaseConfig,
    escapeHtml,
    formatHistoryTime,
    debounce,
    setHtmlIfChanged,
    openModal,
    closeModal,
    transitionViews,
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
    activeTaskGroups,
    carryForwardTasks,
    rollOverTasksInCloud,
    setRepairCompletion,
    mergeRepairChanges,
    saveTrackerDataAndNotes,
    syncRepairTasksToCloud,
    completeRepairTaskInCloud,
    pendingRepairCompletions,
    queueRepairCompletion,
    applyPendingRepairCompletions,
    flushRepairCompletions,
    updateTask,
    restoreTaskMove,
    initThemeSwitcher,
    initModuleTransition,
    navigateModule,
    filterHistory
  });
  initTheme();
})();
