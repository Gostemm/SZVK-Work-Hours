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
    const finish = () => {
      if (modalAnimations.get(modal) !== state) return;
      state.cleanup();
      if (!opening) modal.dispatchEvent(new Event('szvk-modal-closed', { bubbles: true }));
    };
    state.finished = fade.finished.then(finish, finish);
    return state.finished;
  }

  function openModal(modal) { return animateModal(modal, true); }
  function closeModal(modal) { return animateModal(modal, false); }

  function stabilizeTaskControls(container) {
    let pressed = false;
    container.addEventListener('pointerdown', event => {
      const control = event.target.closest('.task-modal-checkbox, .active-task-check');
      if (pressed || !control) return;
      const animations = document.getAnimations().filter(animation => animation.playState === 'running' &&
        animation.effect?.target?.contains?.(control));
      if (!animations.length) return;
      pressed = true;
      animations.forEach(animation => animation.pause());
      const release = () => {
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
        window.removeEventListener('blur', release);
        pressed = false;
        // Let the native click/change finish before moving its hit target again.
        window.requestAnimationFrame(() => animations.forEach(animation => {
          if (animation.playState === 'paused') animation.play();
        }));
      };
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
      window.addEventListener('blur', release);
    });
  }

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
  // Reuse unchanged table/list rows and their controls, including running animations.
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
        const parser = document.createElement(container.tagName === 'TBODY' ? 'tbody' : 'template');
        parser.innerHTML = buildHtml(item);
        entry = { signature, element: (parser.content || parser).firstElementChild };
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

  const listChanges = new Map();
  const listChangeSeen = new WeakMap();
  const listTransitions = new WeakMap();
  const activeListTransitions = new Set();
  const taskMotionTiming = { duration: 340, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
  let listChangeSequence = 0;
  const listMotionNow = () => window.performance?.now() ?? Date.now();

  function markListChange(category, id, kind, delay = 0) {
    const now = listMotionNow();
    for (const [key, change] of listChanges) if (change.expires <= now) listChanges.delete(key);
    const key = category + ':' + String(id);
    // A live-list refresh must preserve the action's delay while its dialog closes.
    if (listChanges.get(key)?.kind === kind) return;
    listChanges.set(key, { category, id: String(id), kind, delay, sequence: ++listChangeSequence, expires: now + 1200 });
  }

  function listClipBounds(container) {
    const clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let parent = container; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left + parent.clientLeft);
        clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top + parent.clientTop);
        clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight);
      }
    }
    if (container.tagName === 'TBODY') {
      const heading = container.closest('table').querySelector('thead th');
      if (heading && getComputedStyle(heading).position === 'sticky') clip.top = Math.max(clip.top, heading.getBoundingClientRect().bottom);
    }
    return clip;
  }

  function listExitSnapshot(element) {
    const style = getComputedStyle(element);
    const copy = element.cloneNode(true);
    // Decorative copies never duplicate live identifiers or accept interaction.
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        if (/^(id|name|for|autofocus|required)$/.test(attribute.name) || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
      }
      if (node.matches('button, input, select, textarea, fieldset')) node.disabled = true;
    }
    copy.classList.remove('active-task-item', 'task-modal-item');
    copy.inert = true;
    copy.setAttribute('aria-hidden', 'true');
    for (const property of ['display', 'box-sizing', 'padding', 'border', 'border-radius', 'background-color', 'color', 'font', 'gap', 'grid-template-columns', 'align-items', 'justify-content', 'list-style', 'box-shadow', 'opacity']) {
      copy.style.setProperty(property, style.getPropertyValue(property));
    }
    const styledChildren = 'td, .task-modal-text, .task-carried-from';
    const originalChildren = element.querySelectorAll(styledChildren);
    copy.querySelectorAll(styledChildren).forEach((node, index) => {
      const originalStyle = getComputedStyle(originalChildren[index]);
      for (const property of ['color', 'background-color', 'font', 'text-decoration']) node.style.setProperty(property, originalStyle.getPropertyValue(property));
    });
    Object.assign(copy.style, { margin: '0', transform: 'none', translate: 'none', pointerEvents: 'none' });
    if (element.tagName === 'TR') {
      [...copy.cells].forEach((cell, index) => {
        cell.style.width = element.cells[index].getBoundingClientRect().width + 'px';
      });
      const table = document.createElement('table');
      table.className = element.closest('table').className;
      Object.assign(table.style, { margin: '0', minWidth: '0', tableLayout: 'fixed' });
      const body = document.createElement('tbody');
      body.appendChild(copy);
      table.appendChild(body);
      return { element: table, opacity: style.opacity };
    }
    return { element: copy, opacity: style.opacity };
  }

  function revealListEntry(container, category, entries, selector, keyAttribute) {
    if (category !== 'task' || !entries.length) return false;
    const element = [...container.querySelectorAll(selector)].find(node => entries.some(change => node.getAttribute(keyAttribute) === change.id));
    const scroller = container.closest('.active-tasks-body') || container;
    if (!element || !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) return false;
    const previous = scroller.scrollTop;
    const bounds = scroller.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const top = bounds.top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    if (rect.bottom > bottom) scroller.scrollTop += rect.bottom - bottom;
    else if (rect.top < top) scroller.scrollTop += rect.top - top;
    return scroller.scrollTop !== previous;
  }

  function animateListUpdate(container, category, selector, keyAttribute, update) {
    if (!container || typeof container.animate !== 'function') return update();
    const now = listMotionNow();
    const seen = listChangeSeen.get(container) || new Set();
    const changes = [...listChanges.values()].filter(change => change.category === category && change.expires > now && !seen.has(change.sequence));
    if (!changes.length) return update();
    const liveSequences = new Set([...listChanges.values()].filter(change => change.expires > now).map(change => change.sequence));
    for (const sequence of seen) if (!liveSequences.has(sequence)) seen.delete(sequence);
    changes.forEach(change => seen.add(change.sequence));
    listChangeSeen.set(container, seen);
    if (getComputedStyle(container).visibility !== 'visible' || container.closest('[inert]')) return update();
    const clip = listClipBounds(container);
    const visible = (rect, area = clip) => area.right > area.left && area.bottom > area.top && rect.width > 0 && rect.height > 0 && rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom;
    const before = new Map([...container.querySelectorAll(selector)].map(element => [element.getAttribute(keyAttribute), { element, bounds: element.getBoundingClientRect() }]));
    const previousMessage = container.querySelector('.completed-tasks > summary, .active-tasks-empty');
    const previousMessageBounds = previousMessage?.getBoundingClientRect();
    if (modalMotionPreference.matches) {
      const result = update();
      revealListEntry(container, category, changes.filter(change => change.kind === 'reopen' || (change.kind === 'add' && !before.has(change.id))), selector, keyAttribute);
      return result;
    }
    const exits = changes.filter(change => (change.kind === 'delete' || (category === 'task' && change.kind === 'complete')) && before.has(change.id)).map(change => {
      const item = before.get(change.id);
      return visible(item.bounds) ? { ...item, change, snapshot: listExitSnapshot(item.element) } : null;
    }).filter(Boolean);
    const sizeHost = container.tagName === 'TBODY' ? container.closest('table').parentElement : container;
    const startBounds = sizeHost.getBoundingClientRect();
    const startHeight = startBounds.height;
    const result = update();
    const after = new Map([...container.querySelectorAll(selector)].map(element => [element.getAttribute(keyAttribute), element]));
    const entries = changes.filter(change => after.has(change.id) &&
      ((change.kind === 'add' && !before.has(change.id)) || change.kind === 'reopen' || (category === 'task' && change.kind === 'complete')));
    const removals = exits.filter(item => item.change.kind === 'complete' || !after.has(item.change.id));
    const statusChanges = category === 'repair' ? changes.filter(change => ['complete', 'reopen'].includes(change.kind) && after.has(change.id)) : [];
    if (!entries.length && !removals.length && !statusChanges.length) return result;
    // A change in another list must not interrupt this list's current layout.
    listTransitions.get(container)?.cleanupLayout();
    for (const state of activeListTransitions) {
      if (state.container === container && changes.some(change => state.keys.has(change.id))) state.cleanup();
    }
    const revealed = revealListEntry(container, category, entries.filter(change => change.kind !== 'complete'), selector, keyAttribute);
    const delay = Math.max(...entries.map(change => change.delay), ...removals.map(item => item.change.delay), ...statusChanges.map(change => change.delay), 0);
    const timing = { ...taskMotionTiming, delay, fill: 'both' };
    const animations = [];
    const layoutAnimations = [];
    const ghosts = [];
    const entryClip = listClipBounds(container);
    const entryBounds = new Map(entries.map(change => [change.id, after.get(change.id).getBoundingClientRect()]));
    // Restore the displayed height before measuring row offsets. A centred dialog
    // otherwise shifts once during measurement and a second time when height animates.
    const endBounds = sizeHost.getBoundingClientRect();
    const endHeight = endBounds.height;
    if (!revealed && Math.abs(startHeight - endHeight) > 1) layoutAnimations.push(sizeHost.animate([{ height: startHeight + 'px' }, { height: endHeight + 'px' }], timing));
    for (const change of entries) {
      const element = after.get(change.id);
      if (!visible(entryBounds.get(change.id), entryClip)) continue;
      animations.push(element.animate([
        { opacity: 0, translate: '0 4px' },
        { opacity: getComputedStyle(element).opacity, translate: '0 0' }
      ], timing));
    }
    for (const item of removals) {
      const ghost = document.createElement('div');
      ghost.className = 'list-motion-ghost';
      ghost.dataset.listMotion = category;
      ghost.dataset.motionKey = item.change.id;
      ghost.dataset.motionKind = item.change.kind;
      ghost.inert = true;
      ghost.setAttribute('aria-hidden', 'true');
      const ghostBounds = (area, bounds) => {
        const left = Math.max(area.left, bounds.left);
        const top = Math.max(area.top, bounds.top);
        return { left: left + 'px', top: top + 'px', width: Math.max(0, Math.min(area.right, bounds.right) - left) + 'px', height: Math.max(0, Math.min(area.bottom, bounds.bottom) - top) + 'px' };
      };
      const from = ghostBounds(clip, startBounds);
      const to = ghostBounds(entryClip, endBounds);
      Object.assign(ghost.style, from, { position: 'fixed', overflow: 'hidden', pointerEvents: 'none', zIndex: '50' });
      const copy = item.snapshot.element;
      Object.assign(copy.style, { position: 'absolute', left: (item.bounds.left - parseFloat(from.left)) + 'px', top: (item.bounds.top - parseFloat(from.top)) + 'px', width: item.bounds.width + 'px', height: item.bounds.height + 'px' });
      ghost.appendChild(copy);
      (container.closest('dialog[open], .modal-overlay.active') || document.body).appendChild(ghost);
      ghosts.push(ghost);
      // Follow the list as a centred dialog resizes, clipping the fading row away
      // from its heading and form instead of leaving a fixed copy over them.
      animations.push(ghost.animate([from, to], timing));
      const completed = item.change.kind === 'complete';
      if (completed) {
        copy.style.boxShadow = 'inset 2px 0 rgba(16, 185, 129, 0.35)';
        copy.querySelectorAll('.active-task-text, .task-modal-text').forEach(text => { text.style.textDecoration = 'line-through'; });
      }
      animations.push(copy.animate([
        { opacity: item.snapshot.opacity, translate: '0 0' },
        { opacity: 0, translate: '0 -2px' }
      ], timing));
    }
    for (const change of statusChanges) {
      const element = after.get(change.id);
      if (!visible(element.getBoundingClientRect(), entryClip)) continue;
      animations.push(element.animate([
        { opacity: 0.8, boxShadow: 'inset 2px 0 ' + (change.kind === 'complete' ? 'rgba(16, 185, 129, 0.35)' : 'rgba(59, 130, 246, 0.35)') },
        { opacity: 1, boxShadow: 'inset 0 0 transparent' }
      ], timing));
    }
    for (const [key, element] of after) {
      if (!before.has(key) || entries.some(change => change.id === key)) continue;
      const rect = element.getBoundingClientRect();
      const offset = before.get(key).bounds.top - rect.top;
      if (!revealed && Math.abs(offset) > 1 && visible(rect)) layoutAnimations.push(element.animate([{ translate: '0 ' + offset + 'px' }, { translate: '0 0' }], timing));
    }
    const message = container.querySelector('.completed-tasks > summary, .active-tasks-empty');
    if (message && removals.length && visible(message.getBoundingClientRect(), entryClip)) {
      const offset = previousMessageBounds ? previousMessageBounds.top - message.getBoundingClientRect().top : 8;
      layoutAnimations.push(message.animate([
        { opacity: previousMessageBounds ? 1 : 0, translate: '0 ' + offset + 'px' },
        { opacity: 1, translate: '0 0' }
      ], previousMessageBounds ? timing : { ...timing, delay: delay + 90, duration: timing.duration - 90 }));
    }
    let timer;
    const state = { container, keys: new Set([...entries, ...statusChanges, ...removals.map(item => item.change)].map(change => change.id)), cleanupLayout() {
      layoutAnimations.forEach(animation => animation.cancel());
      if (listTransitions.get(container) === state) listTransitions.delete(container);
    }, cleanup() {
      window.clearTimeout(timer);
      animations.forEach(animation => animation.cancel());
      ghosts.forEach(ghost => ghost.remove());
      activeListTransitions.delete(state);
      state.cleanupLayout();
    } };
    listTransitions.set(container, state);
    activeListTransitions.add(state);
    timer = window.setTimeout(state.cleanup, delay + timing.duration + 120);
    Promise.allSettled([...animations, ...layoutAnimations].map(animation => animation.finished)).then(state.cleanup);
    return result;
  }

  modalMotionPreference.addEventListener?.('change', event => {
    if (event.matches) [...activeListTransitions].forEach(state => state.cleanup());
  });

  const taskCounterCounts = new WeakMap();
  const pendingTaskCounterMotions = new Map();
  const taskCounterMotions = new WeakMap();
  const activeTaskCounterMotions = new Set();

  function flushTaskCounterMotions() {
    if (document.querySelector('.modal-overlay.active, .modal-overlay.is-closing, dialog[open]')) return;
    for (const [card, job] of pendingTaskCounterMotions) {
      pendingTaskCounterMotions.delete(card);
      if (!card.isConnected || modalMotionPreference.matches) continue;
      const bounds = card.getBoundingClientRect();
      const clip = listClipBounds(card);
      if (!bounds.width || !bounds.height || bounds.bottom <= clip.top || bounds.top >= clip.bottom || bounds.right <= clip.left || bounds.left >= clip.right) continue;
      taskCounterMotions.get(card)?.cleanup();
      const timing = { ...taskMotionTiming, fill: 'both' };
      const color = job.kind === 'complete' ? '16, 185, 129' : job.kind === 'delete' ? '239, 68, 68' : '56, 189, 248';
      const shadow = getComputedStyle(card).boxShadow;
      const highlight = 'inset 0 0 0 1px rgba(' + color + ', 0.28)';
      const animations = [card.animate([
        { boxShadow: shadow },
        { boxShadow: highlight, offset: 0.45 },
        { boxShadow: shadow }
      ], timing)];
      card.dataset.taskMotion = job.kind;
      card.querySelectorAll('.day-task-counter').forEach(counter => {
        if (job.previous[counter.dataset.taskView] === job.next[counter.dataset.taskView]) return;
        animations.push(counter.animate([
          { opacity: 0, translate: '0 2px' },
          { opacity: 1, translate: '0 0' }
        ], timing));
      });
      const ghosts = job.snapshots.map(snapshot => {
        const copy = snapshot.element;
        copy.classList.add('calendar-task-ghost');
        Object.assign(copy.style, { position: 'absolute', left: snapshot.left + 'px', top: snapshot.top + 'px', width: snapshot.width + 'px', height: snapshot.height + 'px', zIndex: '2' });
        card.appendChild(copy);
        animations.push(copy.animate([
          { opacity: snapshot.opacity, translate: '0 0' },
          { opacity: 0, translate: '0 -2px' }
        ], timing));
        return copy;
      });
      const state = { cleanup() {
        animations.forEach(animation => animation.cancel());
        ghosts.forEach(ghost => ghost.remove());
        activeTaskCounterMotions.delete(state);
        if (taskCounterMotions.get(card) === state) {
          taskCounterMotions.delete(card);
          delete card.dataset.taskMotion;
        }
      } };
      taskCounterMotions.set(card, state);
      activeTaskCounterMotions.add(state);
      Promise.allSettled(animations.map(animation => animation.finished)).then(state.cleanup);
    }
  }

  function animateTaskCounters(card, next, update) {
    const previous = taskCounterCounts.get(card);
    taskCounterCounts.set(card, next);
    if (!previous || (previous.active === next.active && previous.done === next.done) || modalMotionPreference.matches || typeof card.animate !== 'function') return update();
    const bounds = card.getBoundingClientRect();
    const snapshots = [...card.querySelectorAll('.day-task-counter')].filter(counter =>
      previous[counter.dataset.taskView] !== next[counter.dataset.taskView]).map(counter => {
        const rect = counter.getBoundingClientRect();
        const snapshot = listExitSnapshot(counter);
        snapshot.element.style.background = getComputedStyle(counter).background;
        snapshot.element.classList.remove('day-task-counter', 'active', 'done');
        const children = counter.querySelectorAll('.counter-icon, .counter-value');
        snapshot.element.querySelectorAll('.counter-icon, .counter-value').forEach((child, index) => {
          child.style.display = getComputedStyle(children[index]).display;
          child.className = '';
        });
        return { ...snapshot, left: rect.left - bounds.left - card.clientLeft, top: rect.top - bounds.top - card.clientTop, width: rect.width, height: rect.height };
      });
    const result = update();
    const kind = next.done > previous.done ? 'complete' : next.active + next.done < previous.active + previous.done ? 'delete' : next.done < previous.done ? 'reopen' : 'add';
    pendingTaskCounterMotions.set(card, { previous, next, kind, snapshots });
    flushTaskCounterMotions();
    return result;
  }

  // Focus restoration may reopen a task sheet; wait for it before revealing the calendar effect.
  const scheduleTaskCounterMotions = () => window.requestAnimationFrame(flushTaskCounterMotions);
  document.addEventListener?.('szvk-modal-closed', scheduleTaskCounterMotions);
  document.addEventListener?.('close', scheduleTaskCounterMotions, true);
  modalMotionPreference.addEventListener?.('change', event => {
    if (!event.matches) return;
    pendingTaskCounterMotions.clear();
    [...activeTaskCounterMotions].forEach(state => state.cleanup());
  });

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
          <a class="useful-link" href="https://sonceslav.citrussnow32.chatgpt.site/game/" target="_blank" rel="noopener noreferrer" aria-label="Сонцеслав (відкриється в новій вкладці)">
            <img class="useful-link-logo" src="assets/sontseslav.webp" width="56" height="56" alt="" decoding="async">
            <span class="useful-link-copy"><strong>Сонцеслав</strong></span>
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
      <summary>◷ Обрати час</summary>
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
    picker.querySelector('summary').textContent = value ? '◷ Час: ' + value : '◷ Обрати час';
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

  function repairTaskHref(repairId, report = false, dateKey = '') {
    return 'trackers.html?' + (report ? 'finishRepair=' : 'editRepair=') + encodeURIComponent(repairId) +
      (report && isValidDateKey(dateKey) ? '&taskDate=' + dateKey : '');
  }

  function repairTaskControlHtml(task, dateKey) {
    if (task.done) return '<input type="checkbox" class="task-modal-checkbox repair-completed-check" checked disabled aria-label="Ремонт виконано" title="Позначка проставляється автоматично після збереження звіту">';
    return `<a class="repair-report-trigger" href="${repairTaskHref(task.repairId, true, dateKey)}" data-repair-id="${escapeHtml(task.repairId)}" data-repair-mode="report" data-task-date="${dateKey}" aria-label="Звітувати про завершення ремонту: ${escapeHtml(task.text)}" title="Відкрити звіт про завершення ремонту"><span aria-hidden="true">📋</span><span>Звіт</span></a>`;
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
      if (reconcileRepairTasks(schedule.dayNotes, repairs, removeMissing)) {
        localStorage.setItem(key, JSON.stringify(schedule));
        window.dispatchEvent?.(new Event('szvk-schedule-updated'));
      }
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
      const result = applyRepairCompletionRequest(repairs, request);
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
      if (repairs.some(repair => String(repair.id) === String(request.repairId))) applyRepairCompletionRequest(repairs, request);
    }
  }

  function applyRepairCompletionRequest(repairs, request) {
    const result = setRepairCompletion(repairs, request.repairId, request.done, request.dateKey, request.user);
    if (request.report) {
      result.repair.workHoursTask ||= { dateKey: request.dateKey };
      for (const field of ['repairDate', 'specialist', 'solution', 'notes', 'needInvoice']) {
        if (Object.prototype.hasOwnProperty.call(request.report, field)) result.repair[field] = request.report[field];
      }
      if (!isRepairPending(result.repair)) result.repair.workHoursTask.completedBy = request.user.username || request.user.name;
      else delete result.repair.workHoursTask.completedBy;
      result.changed = JSON.stringify(result.previous) !== JSON.stringify(result.repair);
    }
    return result;
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


  function deleteManualTask(dayNotes, dateKey, taskId) {
    const tasks = dayNotes[dateKey];
    if (!Array.isArray(tasks)) return null;
    const index = tasks.findIndex(task => String(task.id) === String(taskId));
    if (index === -1 || tasks[index].repairId != null) return null;
    const [task] = tasks.splice(index, 1);
    if (!tasks.length) delete dayNotes[dateKey];
    return task;
  }

  // Replay only the intended task change against fresh cloud data. Other days,
  // task metadata and schedule fields remain owned by their existing writers.
  function applyScheduleTaskChange(dayNotes, change) {
    const entry = Object.entries(dayNotes).find(([, tasks]) => Array.isArray(tasks) &&
      tasks.some(task => String(task.id) === String(change.taskId)));
    if (!entry) return false;
    if (change.kind === 'edit') {
      updateTask(dayNotes, entry[0], change.taskId, change.text, change.targetDateKey, change.time);
    } else if (change.kind === 'delete') {
      return Boolean(deleteManualTask(dayNotes, entry[0], change.taskId));
    } else if (change.kind === 'done') {
      const task = entry[1].find(task => String(task.id) === String(change.taskId));
      task.done = change.done;
    }
    return true;
  }

  function createScheduleTaskStore({ db, scheduleDoc, onChange, onError }) {
    const cacheKey = 'szvk_schedule_local_data';
    const pendingKey = 'szvk_pending_schedule_tasks';
    const read = (key, fallback) => {
      try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
      catch (error) { return fallback; }
    };
    let data = read(cacheKey, {});
    let syncing = null;
    let hasRemoteSnapshot = false;
    function accept(next) {
      data = { ...next, dayNotes: next.dayNotes || {}, overrides: next.overrides || {} };
      applyPendingScheduleTaskChanges(data.dayNotes);
      carryForwardTasks(data.dayNotes, kyivDateKey(), !db);
      localStorage.setItem(cacheKey, JSON.stringify(data));
      onChange();
    }
    function refresh() { accept(read(cacheKey, {})); }
    function flush() {
      if (!db || !scheduleDoc) return Promise.resolve();
      if (syncing) return syncing;
      if (!read(pendingKey, []).length) return Promise.resolve();
      syncing = flushScheduleTaskChanges(db, scheduleDoc, accept)
        .catch(error => onError(error)).finally(() => { syncing = null; });
      return syncing;
    }
    function save(change) {
      if (db && scheduleDoc) {
        queueScheduleTaskChange(change);
      }
      localStorage.setItem(cacheKey, JSON.stringify(data));
      onChange();
      return syncing ? syncing.then(flush) : flush();
    }
    data.dayNotes ||= {};
    data.overrides ||= {};
    window.addEventListener('storage', event => {
      if ([cacheKey, pendingKey].includes(event.key)) refresh();
    });
    window.addEventListener('szvk-schedule-updated', refresh);
    window.addEventListener('online', flush);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.setInterval(refresh, 60000);
    if (scheduleDoc) scheduleDoc.onSnapshot(snapshot => {
      const fromCache = snapshot.metadata?.fromCache;
      if (fromCache && hasRemoteSnapshot) return;
      if (!fromCache && snapshot.exists) hasRemoteSnapshot = true;
      if (snapshot.exists) accept(snapshot.data());
      flush();
    }, onError);
    refresh();
    flush();
    return { getData: () => data, save, refresh };
  }

  function pendingScheduleTaskChanges() {
    try { return JSON.parse(localStorage.getItem('szvk_pending_schedule_tasks') || '[]'); }
    catch (error) { return []; }
  }

  function queueScheduleTaskChange(change) {
    const pending = pendingScheduleTaskChanges();
    pending.push({ ...change, id: Date.now() + '-' + Math.random().toString(36).slice(2) });
    localStorage.setItem('szvk_pending_schedule_tasks', JSON.stringify(pending));
  }

  function mergeScheduleTaskCompletions(dayNotes, remoteNotes) {
    const latest = new Map(Object.values(remoteNotes || {}).filter(Array.isArray).flat().filter(Boolean).map(task => [String(task.id), task]));
    for (const tasks of Object.values(dayNotes)) {
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        const remote = latest.get(String(task.id));
        if (remote && task.repairId == null && remote.repairId == null) task.done = Boolean(remote.done);
      }
    }
    // Whole-calendar saves own schedule fields, not another writer's task status.
    applyPendingScheduleTaskChanges(dayNotes);
    return dayNotes;
  }

  function applyPendingScheduleTaskChanges(dayNotes) {
    for (const change of pendingScheduleTaskChanges()) applyScheduleTaskChange(dayNotes, change);
  }

  async function flushScheduleTaskChanges(db, scheduleDoc, onSave = () => {}) {
    while (pendingScheduleTaskChanges().length) {
      const batch = pendingScheduleTaskChanges();
      const saved = await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(scheduleDoc);
        const next = snapshot.exists ? snapshot.data() : {};
        const dayNotes = next.dayNotes || {};
        for (const change of batch) applyScheduleTaskChange(dayNotes, change);
        transaction.set(scheduleDoc, { dayNotes, updatedAt: Date.now() }, { mergeFields: ['dayNotes', 'updatedAt'] });
        return { ...next, dayNotes };
      });
      const ids = new Set(batch.map(change => change.id));
      localStorage.setItem('szvk_pending_schedule_tasks', JSON.stringify(pendingScheduleTaskChanges().filter(change => !ids.has(change.id))));
      onSave(saved);
    }
  }

  function mountTaskWorkspace(options) {
    const getDayTasks = dateKey => options.getDayNotes()[dateKey] || [];
    const MONTH_NAMES = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
    const formatDateKey = (year, month, day) => String(year).padStart(4,'0') + '-' + String(month + 1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
    options.content.insertAdjacentHTML('beforeend', `<aside class="active-tasks-host" id="activeTasksHost" aria-label="Поточні завдання" hidden>
    <section class="active-tasks-panel" id="activeTasksPanel" aria-labelledby="activeTasksTitle">
      <button type="button" class="active-tasks-toggle" id="activeTasksToggle" aria-expanded="true" aria-controls="activeTasksBody">
        <span class="active-tasks-mark" aria-hidden="true"></span>
        <span class="active-tasks-title" id="activeTasksTitle">Зараз у роботі</span>
        <span class="active-tasks-count" id="activeTasksCount" aria-live="polite" aria-atomic="true">0</span>
        <span class="active-tasks-chevron" id="activeTasksChevron" aria-hidden="true">⌃</span>
      </button>
      <div class="active-tasks-body" id="activeTasksBody">
        <p class="active-tasks-hint">На сьогодні та перенесені з попередніх днів</p>
        <ul class="active-tasks-list" id="activeTasksList" aria-label="Завдання у роботі"></ul>
        <details class="active-tasks-planned" id="activeTasksPlanned" hidden>
          <summary>Заплановані <span id="activeTasksPlannedCount">0</span></summary>
          <ul class="active-tasks-list" id="activeTasksPlannedList" aria-label="Майбутні завдання"></ul>
        </details>
      </div>
    </section>
    <button type="button" class="active-tasks-rail" id="activeTasksRail" aria-expanded="false" aria-controls="activeTasksPanel" aria-label="Розгорнути список завдань">
      <span class="active-tasks-chevron" aria-hidden="true">‹</span>
      <span class="active-tasks-count" id="activeTasksRailCount">0</span>
      <span class="active-tasks-rail-title">Зараз у роботі</span>
    </button>
  </aside>`);
    options.container.insertAdjacentHTML('beforeend', `<button type="button" class="active-tasks-dock" id="activeTasksDock" aria-haspopup="dialog" aria-controls="activeTasksSheet" aria-expanded="false" hidden>
    <span class="active-tasks-mark" aria-hidden="true"></span>
    <span class="active-tasks-dock-copy">
      <span class="active-tasks-dock-title">У роботі <span class="active-tasks-count" id="activeTasksDockCount">0</span></span>
      <span class="active-tasks-dock-preview" id="activeTasksDockPreview"></span>
    </span>
    <span class="active-tasks-chevron" aria-hidden="true">⌃</span>
  </button>
  <dialog class="active-tasks-sheet" id="activeTasksSheet" aria-labelledby="activeTasksTitle">
    <div class="active-tasks-handle" aria-hidden="true"></div>
  </dialog>`);
    document.body.insertAdjacentHTML('beforeend', `<!-- Редагування та перенесення завдання -->
<div class="modal-overlay" id="taskEditorModal" role="dialog" aria-modal="true" aria-labelledby="taskEditorTitle">
  <div class="modal-box">
    <div class="modal-header">
      <h3 id="taskEditorTitle">Редагувати завдання</h3>
      <button type="button" class="btn" id="taskEditorClose" aria-label="Закрити">✕</button>
    </div>
    <form id="taskEditorForm" class="task-editor-form">
      <label>Завдання
        <textarea id="taskEditorText" maxlength="140" required rows="3"></textarea>
      </label>
      <div id="taskEditorTimeMount"></div>
      <input type="hidden" id="taskEditorDate">
      <div class="task-shift-preview" id="taskEditorShift" role="status" aria-live="polite"></div>
      <section class="task-mini-calendar" aria-label="Календар вибору дня виконання">
        <div class="task-calendar-header">
          <button type="button" class="task-calendar-nav" id="taskCalendarPrev" aria-label="Попередній місяць">‹</button>
          <h4 id="taskCalendarMonth" role="status" aria-live="polite"></h4>
          <button type="button" class="task-calendar-nav" id="taskCalendarNext" aria-label="Наступний місяць">›</button>
        </div>
        <div class="task-calendar-weekdays" aria-hidden="true"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Нд</span></div>
        <div class="task-calendar-days" id="taskCalendarDays" role="group" aria-label="Дні місяця"></div>
        <div class="task-calendar-legend">
          <span class="artem">● Артем</span><span class="oleksandr">● Олександр</span><span>↔ підміна · № зміни</span>
        </div>
      </section>
      <p class="task-editor-error" id="taskEditorError" role="alert" hidden></p>
      <div class="modal-footer">
        <button type="button" class="btn" id="taskEditorCancel">Скасувати</button>
        <button type="submit" class="btn" id="taskEditorSave" style="background:var(--accent);color:#fff">Зберегти</button>
      </div>
    </form>
  </div>
</div>`);
    document.getElementById('taskEditorTimeMount').innerHTML = taskTimePickerHtml();
    initTaskTimePickers(document.getElementById('taskEditorTimeMount'));
    let activeTaskEdit = null;
    let taskEditorReturnFocus = null;
    let taskEditorReturnTarget = null;
    let taskEditorFromSheet = false;
    let taskCalendarView = null;
    let taskCalendarSignature = '';

    function openTaskEditor(dateKey, taskId, mode = 'edit') {
      const task = getDayTasks(dateKey).find(item => String(item.id) === String(taskId));
      if (!task) return;
      const row = document.activeElement?.closest('.active-task-item');
      taskEditorReturnFocus = document.activeElement;
      taskEditorReturnTarget = row ? { taskId: row.dataset.taskId } : null;
      taskEditorFromSheet = activeTasksSheet.open;
      if (taskEditorFromSheet) closeActiveTasksSheet(false, false);
      activeTaskEdit = { dateKey, taskId: task.id, mode };
      document.getElementById('taskEditorTitle').textContent = mode === 'move' ? 'Перенести завдання' : 'Редагувати завдання';
      document.getElementById('taskEditorText').value = task.text;
      document.getElementById('taskEditorText').readOnly = task.repairId != null;
      document.getElementById('taskEditorText').maxLength = task.repairId != null ? Math.max(140, task.text.length) : 140;
      const picker = document.querySelector('#taskEditorTimeMount .task-time-picker');
      window.SZVKShared.setTaskTimePicker(picker, task.time || '');
      picker.open = false;
      document.getElementById('taskEditorDate').value = dateKey;
      document.getElementById('taskEditorSave').textContent = mode === 'move' ? 'Перенести на обрану зміну' : 'Зберегти';
      const [year, month] = dateKey.split('-').map(Number);
      taskCalendarView = { year, month: month - 1 };
      taskCalendarSignature = '';
      updateTaskShiftPreview();
      document.getElementById('taskEditorError').hidden = true;
      window.SZVKShared.openModal(document.getElementById('taskEditorModal'));
      if (mode === 'move') document.querySelector('#taskCalendarDays [aria-pressed="true"]').focus();
      else document.getElementById('taskEditorText').focus();
    }

    function closeTaskEditor() {
      const dismissed = window.SZVKShared.closeModal(document.getElementById('taskEditorModal'));
      const fromSheet = taskEditorFromSheet;
      const returnTarget = taskEditorReturnTarget;
      const returnFocus = taskEditorReturnFocus;
      activeTaskEdit = null;
      taskEditorFromSheet = false;
      const restoreFocus = () => {
        if (activeTaskEdit || !options.isVisible()) return;
        if (fromSheet && activeTasksCompact.matches) activeTasksDock.click();
        const row = returnTarget && [...activeTasksPanel.querySelectorAll('.active-task-item')].find(item => item.dataset.taskId === returnTarget.taskId);
        const target = row?.querySelector('.active-task-edit') || (returnFocus?.isConnected ? returnFocus : fromSheet ? activeTasksToggle : null);
        target?.focus({ preventScroll: true });
      };
      if (dismissed?.then) dismissed.then(restoreFocus);
      else restoreFocus();
    }

    function refreshTaskEditorSource() {
      if (!activeTaskEdit || getDayTasks(activeTaskEdit.dateKey).some(task => String(task.id) === String(activeTaskEdit.taskId))) return;
      const source = Object.entries(options.getDayNotes()).find(([, tasks]) => Array.isArray(tasks) && tasks.some(task => String(task.id) === String(activeTaskEdit.taskId)));
      if (!source) return;
      const previousDateKey = activeTaskEdit.dateKey;
      activeTaskEdit.dateKey = source[0];
      const dateInput = document.getElementById('taskEditorDate');
      if (dateInput.value === previousDateKey) {
        dateInput.value = source[0];
        const [year, month] = source[0].split('-').map(Number);
        taskCalendarView = { year, month: month - 1 };
        taskCalendarSignature = '';
      }
    }

    function taskShiftLabel(dateKey) {
      if (!window.SZVKShared.isValidDateKey(dateKey)) return '';
      const [year, month, day] = dateKey.split('-').map(Number);
      const assignment = window.SZVKShared.shiftInfo(dateKey, options.getOverrides());
      const label = new Date(year, month - 1, day).toLocaleDateString('uk-UA', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
      });
      return `${label} · ${assignment.worker}${assignment.isEdited ? ' (підміна)' : ''} · зміна №${assignment.shiftNum} з 3`;
    }

    function updateTaskShiftPreview() {
      const dateKey = document.getElementById('taskEditorDate').value;
      const label = taskShiftLabel(dateKey);
      const preview = document.getElementById('taskEditorShift');
      const info = window.SZVKShared.shiftInfo(dateKey, options.getOverrides());
      preview.className = 'task-shift-preview' + (info ? info.worker === 'Артем' ? ' artem' : ' oleksandr' : '');
      preview.textContent = label || 'Оберіть дату, щоб побачити працівника зміни.';
      if (activeTaskEdit) renderTaskCalendar();
    }

    function renderTaskCalendar() {
      if (!taskCalendarView || !activeTaskEdit) return;
      const { year, month } = taskCalendarView;
      const days = document.getElementById('taskCalendarDays');
      const selectedDate = document.getElementById('taskEditorDate').value;
      const todayKey = window.SZVKShared.kyivDateKey();
      const signature = JSON.stringify([year, month, selectedDate, todayKey, activeTaskEdit.dateKey, options.getOverrides()]);
      if (taskCalendarSignature === signature) return;
      taskCalendarSignature = signature;
      document.getElementById('taskCalendarMonth').textContent = MONTH_NAMES[month] + ' ' + year;
      document.getElementById('taskCalendarPrev').disabled = year === 1000 && month === 0;
      document.getElementById('taskCalendarNext').disabled = year === 9999 && month === 11;
      days.replaceChildren();
      for (const entry of window.SZVKShared.calendarMonthDays(year, month)) {
        const key = entry.dateKey;
        const info = window.SZVKShared.shiftInfo(key, options.getOverrides());
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'task-calendar-day' + (!entry.inMonth ? ' other-month' : '') + (info ? info.worker === 'Артем' ? ' artem' : ' oleksandr' : '');
        button.dataset.date = key;
        button.disabled = !info;
        button.innerHTML = `<span class="task-calendar-day-number">${entry.day}</span>${info ? `<span class="task-calendar-worker">${info.worker === 'Артем' ? 'А' : 'О'}·${info.shiftNum}</span>${info.isEdited ? '<span class="task-calendar-substitution" aria-hidden="true">↔</span>' : ''}` : ''}`;
        button.setAttribute('aria-label', info ? taskShiftLabel(key) + (key === activeTaskEdit.dateKey ? ' · Поточний день завдання' : '') : 'Дата недоступна');
        button.title = button.getAttribute('aria-label');
        button.setAttribute('aria-pressed', String(key === selectedDate));
        button.tabIndex = key === selectedDate ? 0 : -1;
        if (key === todayKey) { button.classList.add('today'); button.setAttribute('aria-current', 'date'); }
        if (key === activeTaskEdit.dateKey) button.classList.add('source-day');
        days.appendChild(button);
      }
      if (!days.querySelector('[tabindex="0"]')) days.querySelector('button:not(.other-month):not(:disabled)').tabIndex = 0;
    }

    function selectTaskDate(dateKey) {
      if (!window.SZVKShared.isValidDateKey(dateKey)) return;
      document.getElementById('taskEditorDate').value = dateKey;
      const [year, month] = dateKey.split('-').map(Number);
      taskCalendarView = { year, month: month - 1 };
      updateTaskShiftPreview();
      document.querySelector('#taskCalendarDays [aria-pressed="true"]').focus();
    }

    document.getElementById('taskCalendarDays').addEventListener('click', event => {
      const button = event.target.closest('[data-date]');
      if (button && !button.disabled) selectTaskDate(button.dataset.date);
    });
    document.getElementById('taskCalendarDays').addEventListener('keydown', event => {
      const button = event.target.closest('[data-date]');
      const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (!button || !(event.key in offsets)) return;
      event.preventDefault();
      const [year, month, day] = button.dataset.date.split('-').map(Number);
      const date = new Date(year, month - 1, day + offsets[event.key]);
      selectTaskDate(formatDateKey(date.getFullYear(), date.getMonth(), date.getDate()));
    });
    function navigateTaskMonth(offset) {
      const next = new Date(taskCalendarView.year, taskCalendarView.month + offset, 1);
      if (next.getFullYear() < 1000 || next.getFullYear() > 9999) return;
      taskCalendarView = { year: next.getFullYear(), month: next.getMonth() };
      renderTaskCalendar();
    }
    document.getElementById('taskCalendarPrev').onclick = () => navigateTaskMonth(-1);
    document.getElementById('taskCalendarNext').onclick = () => navigateTaskMonth(1);
    document.getElementById('taskEditorDate').addEventListener('input', () => selectTaskDate(document.getElementById('taskEditorDate').value));


    document.getElementById('taskEditorClose').onclick = closeTaskEditor;
    document.getElementById('taskEditorCancel').onclick = closeTaskEditor;
    document.getElementById('taskEditorModal').addEventListener('click', event => {
      if (event.target === event.currentTarget) closeTaskEditor();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && activeTaskEdit) { event.preventDefault(); closeTaskEditor(); }
    });
    document.getElementById('taskEditorForm').addEventListener('submit', event => {
      event.preventDefault();
      if (!activeTaskEdit || !event.currentTarget.reportValidity()) return;
      const { dateKey, taskId } = activeTaskEdit;
      const targetDateKey = document.getElementById('taskEditorDate').value;
      try {
        if (activeTaskEdit.mode === 'move' && targetDateKey === dateKey) throw new Error('Оберіть інший день для перенесення завдання.');
        const result = window.SZVKShared.updateTask(options.getDayNotes(), dateKey, taskId, document.getElementById('taskEditorText').value, targetDateKey, document.querySelector('#taskEditorTimeMount .task-time-input').value);
        if (result.changed) {
          options.logAction({
            module: 'schedule', tab: 'day_tasks', type: result.moved ? 'task_move' : 'task_edit',
            description: result.moved ? 'Перенесено завдання: ' + dateKey + ' → ' + taskShiftLabel(targetDateKey) : 'Оновлено завдання на ' + dateKey,
            details: '«' + result.task.text + '»' + (result.task.time ? ' · ' + result.task.time : ''),
            restoreData: result.moved
              ? { fromDateKey: dateKey, toDateKey: targetDateKey, taskId: result.task.id, previous: result.previous }
              : { dateKey, taskId: result.task.id, prevText: result.previous.text, prevTime: result.previous.time || '' },
            editRef: { module: 'schedule', type: 'task', dateKey: targetDateKey, taskId: result.task.id }
          });
          options.onSave({ kind: 'edit', dateKey, targetDateKey, taskId, text: result.task.text, time: result.task.time || '' });
        }
        closeTaskEditor();
        options.onChange();
      } catch (error) {
        const message = document.getElementById('taskEditorError');
        message.textContent = error.message;
        message.hidden = false;
      }
    });


    const activeTasksHost = document.getElementById('activeTasksHost');
    const activeTasksPanel = document.getElementById('activeTasksPanel');
    stabilizeTaskControls(activeTasksPanel);
    const activeTasksSheet = document.getElementById('activeTasksSheet');
    const activeTasksDock = document.getElementById('activeTasksDock');
    const activeTasksToggle = document.getElementById('activeTasksToggle');
    const activeTasksRail = document.getElementById('activeTasksRail');
    const activeTasksCompact = window.matchMedia('(max-width: 1099px)');
    const activeTasksReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let activeTasksExpanded = true;
    let activeTasksPreviousOverflow = '';
    let activeTasksSheetClosing = null;
    let activeTasksPlannedMotion = null;
    try { activeTasksExpanded = localStorage.getItem('szvk_active_tasks_expanded') !== 'false'; } catch (error) {}

    function closeActiveTasksSheet(restoreFocus = true, animate = true) {
      if (!activeTasksSheet.open) return;
      if (activeTasksSheetClosing) {
        if (!animate || activeTasksReducedMotion.matches) activeTasksSheetClosing.finish(restoreFocus);
        return;
      }
      const state = {
        finish(focus = restoreFocus) {
          if (activeTasksSheetClosing !== state) return;
          activeTasksSheetClosing = null;
          activeTasksSheet.close();
          activeTasksSheet.classList.remove('is-closing');
          activeTasksSheet.style.removeProperty('--sheet-exit-start');
          activeTasksSheet.inert = false;
          activeTasksHost.appendChild(activeTasksPanel);
          document.body.style.overflow = activeTasksPreviousOverflow;
          activeTasksDock.setAttribute('aria-expanded', 'false');
          syncActiveTasksPresentation();
          if (focus && !activeTasksDock.hidden) activeTasksDock.focus({ preventScroll: true });
        }
      };
      activeTasksSheetClosing = state;
      if (!animate || activeTasksReducedMotion.matches) { state.finish(); return; }
      // Continue from the current position if the user closes during entry.
      const transform = getComputedStyle(activeTasksSheet).transform;
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      activeTasksSheet.style.setProperty('--sheet-exit-start', offset + 'px');
      activeTasksSheet.inert = true;
      activeTasksSheet.classList.add('is-closing');
      Promise.allSettled(activeTasksSheet.getAnimations().map(animation => animation.finished)).then(() => state.finish());
    }

    function syncActiveTasksPresentation() {
      const visible = options.isVisible();
      const compact = activeTasksCompact.matches;
      if (activeTasksSheet.open && (!visible || !compact)) closeActiveTasksSheet(false, false);
      options.container.classList.toggle('showing-history', !visible);
      activeTasksHost.hidden = !visible || compact;
      activeTasksDock.hidden = !visible || !compact;
      activeTasksHost.classList.toggle('is-collapsed', !compact && !activeTasksExpanded);
      activeTasksPanel.inert = !compact && !activeTasksExpanded;
      activeTasksRail.inert = compact || activeTasksExpanded;
      activeTasksRail.setAttribute('aria-hidden', String(compact || activeTasksExpanded));
      activeTasksRail.setAttribute('aria-expanded', String(activeTasksExpanded));
      activeTasksToggle.setAttribute('aria-expanded', String(compact || activeTasksExpanded));
      activeTasksToggle.title = compact || activeTasksExpanded ? 'Згорнути список завдань' : 'Розгорнути список завдань';
      document.getElementById('activeTasksChevron').textContent = compact ? '⌃' : '›';
    }

    activeTasksDock.addEventListener('click', () => {
      if (!options.isVisible() || !activeTasksCompact.matches || activeTasksSheet.open) return;
      activeTasksSheet.appendChild(activeTasksPanel);
      syncActiveTasksPresentation();
      activeTasksPreviousOverflow = document.body.style.overflow;
      activeTasksSheet.showModal();
      document.body.style.overflow = 'hidden';
      activeTasksDock.setAttribute('aria-expanded', 'true');
    });
    function toggleActiveTasksPanel() {
      if (activeTasksCompact.matches) { closeActiveTasksSheet(); return; }
      activeTasksExpanded = !activeTasksExpanded;
      try { localStorage.setItem('szvk_active_tasks_expanded', String(activeTasksExpanded)); } catch (error) {}
      syncActiveTasksPresentation();
      (activeTasksExpanded ? activeTasksToggle : activeTasksRail).focus({ preventScroll: true });
    }
    activeTasksToggle.addEventListener('click', toggleActiveTasksPanel);
    activeTasksRail.addEventListener('click', toggleActiveTasksPanel);
    activeTasksCompact.addEventListener('change', syncActiveTasksPresentation);
    activeTasksReducedMotion.addEventListener('change', event => {
      if (!event.matches) return;
      activeTasksSheetClosing?.finish();
      activeTasksPlannedMotion?.finish();
    });
    activeTasksSheet.addEventListener('cancel', event => {
      event.preventDefault();
      closeActiveTasksSheet();
    });
    activeTasksSheet.addEventListener('click', event => {
      const bounds = activeTasksSheet.getBoundingClientRect();
      if (event.target === activeTasksSheet && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeActiveTasksSheet();
    });

    document.querySelector('#activeTasksPlanned > summary').addEventListener('click', event => {
      event.preventDefault();
      const details = document.getElementById('activeTasksPlanned');
      const list = document.getElementById('activeTasksPlannedList');
      const opening = !(activeTasksPlannedMotion?.opening ?? details.open);
      const height = details.open ? list.getBoundingClientRect().height : 0;
      const opacity = details.open ? getComputedStyle(list).opacity : 0;
      activeTasksPlannedMotion?.animation.cancel();
      if (activeTasksReducedMotion.matches) {
        activeTasksPlannedMotion = null;
        list.style.removeProperty('overflow');
        details.open = opening;
        return;
      }
      details.open = true;
      list.style.overflow = 'hidden';
      const animation = list.animate([
        { height: height + 'px', opacity },
        { height: (opening ? list.scrollHeight : 0) + 'px', opacity: opening ? 1 : 0 }
      ], { duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'both' });
      const state = { opening, animation, finish() {
        if (activeTasksPlannedMotion !== state) return;
        activeTasksPlannedMotion = null;
        details.open = opening;
        animation.cancel();
        list.style.removeProperty('overflow');
      } };
      activeTasksPlannedMotion = state;
      animation.finished.then(state.finish, state.finish);
    });

    function activeTaskHtml({ dateKey, task }, todayKey) {
      const assignment = window.SZVKShared.shiftInfo(dateKey, options.getOverrides());
      const dateLabel = dateKey === todayKey ? 'Сьогодні' : dateKey.split('-').reverse().join('.');
      return `<li class="active-task-item" data-date="${dateKey}" data-task-id="${escapeHtml(task.id)}">
        ${task.repairId != null ? repairTaskControlHtml(task, dateKey) : `<label class="active-task-check" title="Позначити виконаним">
          <input type="checkbox" aria-label="Виконати: ${escapeHtml(task.text)}">
        </label>`}
        <div class="active-task-content">
          <button type="button" class="active-task-open" title="Відкрити день із цим завданням">
            <span class="active-task-text">${task.time ? `<span class="task-time-badge">${escapeHtml(task.time)}</span> ` : ''}${escapeHtml(task.text)}</span>
            ${taskCarryLabel(task)}
            <span class="active-task-meta"><span>${dateLabel}</span><span class="active-task-worker ${assignment.worker === 'Артем' ? 'artem' : 'oleksandr'}">Чергує: ${escapeHtml(assignment.worker)}</span></span>
          </button>
          ${task.repairId != null ? `<a class="task-repair-link" href="${repairTaskHref(task.repairId)}" data-repair-id="${escapeHtml(task.repairId)}" data-repair-mode="request">🔧 Відкрити ремонт <span aria-hidden="true">↗</span></a>` : ''}
        </div>
        <div class="active-task-actions">
          <button type="button" class="active-task-edit" title="Редагувати завдання" aria-label="Редагувати: ${escapeHtml(task.text)}">✎</button>
          ${task.repairId == null ? `<button type="button" class="active-task-delete" title="Видалити нотатку" aria-label="Видалити нотатку: ${escapeHtml(task.text)}">🗑</button>` : ''}
        </div>
      </li>`;
    }

    let renderedTaskStates = null;
    function renderActiveTasks(todayKey) {
      if (activeTaskEdit) { refreshTaskEditorSource(); updateTaskShiftPreview(); }
      // Observe saved changes from other tabs and cloud snapshots as well as local actions.
      const taskStates = new Map(Object.values(options.getDayNotes()).filter(Array.isArray).flat()
        .filter(task => task && task.id != null).map(task => [String(task.id), Boolean(task.done)]));
      if (renderedTaskStates) {
        for (const [id, done] of taskStates) {
          if (!renderedTaskStates.has(id)) markListChange('task', id, 'add');
          else if (renderedTaskStates.get(id) !== done) markListChange('task', id, done ? 'complete' : 'reopen');
        }
        for (const id of renderedTaskStates.keys()) if (!taskStates.has(id)) markListChange('task', id, 'delete');
      }
      renderedTaskStates = taskStates;
      const { active, planned } = window.SZVKShared.activeTaskGroups(options.getDayNotes(), todayKey);
      document.getElementById('activeTasksCount').textContent = active.length;
      document.getElementById('activeTasksDockCount').textContent = active.length;
      document.getElementById('activeTasksRailCount').textContent = active.length;
      const first = active[0]?.task;
      const preview = first ? (first.time ? first.time + ' · ' : '') + first.text : 'На сьогодні все виконано';
      activeTasksRail.title = `Розгорнути список завдань (${active.length})`;
      activeTasksRail.setAttribute('aria-label', activeTasksRail.title);
      const dockPreview = document.getElementById('activeTasksDockPreview');
      dockPreview.textContent = preview;
      dockPreview.title = preview;
      const activeList = document.getElementById('activeTasksList');
      const activeRows = active.map(entry => ({ id: entry.task.id, html: activeTaskHtml(entry, todayKey) }));
      if (!activeRows.length) activeRows.push({ id: 'empty', html: '<li class="active-tasks-empty"><strong>На сьогодні все виконано</strong>Нові та перенесені завдання з’являться тут.</li>' });
      animateListUpdate(activeList, 'task', '[data-task-id]', 'data-task-id', () => reconcileRows(activeList, activeRows, row => row.html));
      document.getElementById('activeTasksPlannedCount').textContent = planned.length;
      const plannedList = document.getElementById('activeTasksPlannedList');
      if (planned.length) document.getElementById('activeTasksPlanned').hidden = false;
      const plannedRows = planned.map(entry => ({ id: entry.task.id, html: activeTaskHtml(entry, todayKey) }));
      animateListUpdate(plannedList, 'task', '[data-task-id]', 'data-task-id', () => reconcileRows(plannedList, plannedRows, row => row.html));
      document.getElementById('activeTasksPlanned').hidden = planned.length === 0;
      syncActiveTasksPresentation();
    }


    activeTasksPanel.addEventListener('change', async event => {
      if (!event.target.matches('.active-task-check input')) return;
      const checkbox = event.target;
      const row = checkbox.closest('.active-task-item');
      const list = row.parentElement;
      const index = [...list.children].indexOf(row);
      const hadFocus = document.activeElement === checkbox;
      checkbox.disabled = true;
      try { await options.setTaskDone(row.dataset.date, row.dataset.taskId, checkbox.checked); }
      catch (error) { options.onError?.(error); }
      finally { checkbox.disabled = false; }
      if (checkbox.isConnected) checkbox.checked = false;
      if (hadFocus && (activeTasksSheet.open || !activeTasksCompact.matches)) {
        const inputs = list.querySelectorAll('input');
        (inputs[Math.min(index, inputs.length - 1)] || activeTasksToggle).focus({ preventScroll: true });
      }
    });
    activeTasksPanel.addEventListener('click', event => {
      const remove = event.target.closest('.active-task-delete');
      if (remove) {
        const row = remove.closest('.active-task-item');
        const list = row.parentElement;
        const index = [...list.children].indexOf(row);
        const restoreFocus = row.contains(document.activeElement);
        const dateKey = row.dataset.date;
        markListChange('task', row.dataset.taskId, 'delete');
        const task = deleteManualTask(options.getDayNotes(), dateKey, row.dataset.taskId);
        if (!task) return;
        options.logAction({ module: 'schedule', tab: 'day_tasks', type: 'task_delete',
          description: 'Видалено завдання на ' + dateKey, details: '«' + task.text + '»',
          restoreData: { dateKey, task } });
        options.onSave({ kind: 'delete', dateKey, taskId: task.id });
        options.onChange();
        if (restoreFocus) {
          const rows = list.querySelectorAll('.active-task-item');
          const next = rows[Math.min(index, rows.length - 1)];
          (next?.querySelector('.active-task-delete, .active-task-edit') || activeTasksToggle).focus({ preventScroll: true });
        }
        return;
      }
      const repairLink = event.target.closest('[data-repair-mode]');
      if (repairLink) {
        if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        closeActiveTasksSheet(false, false);
        if (options.openRepair) options.openRepair(repairLink.dataset.repairId, repairLink.dataset.repairMode === 'report', repairLink.dataset.taskDate);
        else navigateModule(repairLink.getAttribute('href'));
        return;
      }
      const edit = event.target.closest('.active-task-edit');
      if (edit) {
        const row = edit.closest('.active-task-item');
        openTaskEditor(row.dataset.date, row.dataset.taskId);
        return;
      }
      const button = event.target.closest('.active-task-open');
      if (!button) return;
      const dateKey = button.closest('.active-task-item').dataset.date;
      closeActiveTasksSheet(false, false);
      options.openDay(dateKey);
    });


    return { openTaskEditor, closeActiveTasksSheet, syncActiveTasksPresentation, renderActiveTasks };
  }

  function taskCarryLabel(task) {
    if (!window.SZVKShared.isValidDateKey(task.carriedFrom)) return '';
    return '<span class="task-carried-from">↪ З ' + task.carriedFrom.split('-').reverse().join('.') + '</span>';
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
    stabilizeTaskControls,
    transitionViews,
    markListChange,
    animateListUpdate,
    animateTaskCounters,
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
    repairTaskHref,
    repairTaskControlHtml,
    repairTaskDateKey,
    reconcileRepairTasks,
    syncLocalRepairTasks,
    activeTaskGroups,
    applyScheduleTaskChange,
    queueScheduleTaskChange,
    mergeScheduleTaskCompletions,
    deleteManualTask,
    applyPendingScheduleTaskChanges,
    flushScheduleTaskChanges,
    createScheduleTaskStore,
    mountTaskWorkspace,
    taskCarryLabel,
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
