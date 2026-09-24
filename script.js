/**
 * Ledger — backend-connected version of script.js.
 *
 * Same interface as script.js, but tasks are stored by the API in /backend
 * instead of the browser's localStorage. To use it, load this file from
 * index.html instead of script.js:
 *
 *   <script src="script.api.js"></script>
 */

// Where the backend lives. While developing it runs on your own computer;
// before publishing the site, put your deployed backend URL on the second line.
const API_BASE = ['localhost', '127.0.0.1', ''].includes(location.hostname)
  ? 'http://localhost:3000/api'
  : 'https://YOUR-BACKEND-URL/api';

/** @typedef {{ id: string, text: string, done: boolean, createdAt: number, date: string }} Task */

/** @type {Task[]} */
let tasks = [];
let loaded = false; // becomes true once the first load from the server works
let adding = false; // stops double-submits while a task is being saved
let renderingList = false; // true while render() rebuilds the DOM
let currentFilter = 'all'; // 'all' | 'active' | 'done'
let currentDate = todayStr(); // 'YYYY-MM-DD' — the day currently being viewed
let statusTimer;

const els = {
  form: document.getElementById('entryForm'),
  input: document.getElementById('entryInput'),
  list: document.getElementById('list'),
  empty: document.getElementById('emptyState'),
  filters: document.getElementById('filters'),
  statCount: document.getElementById('statCount'),
  clearDone: document.getElementById('clearDone'),
  dateStamp: document.getElementById('dateStamp'),
  dayPicker: document.getElementById('dayPicker'),
  prevDay: document.getElementById('prevDay'),
  nextDay: document.getElementById('nextDay'),
  todayBtn: document.getElementById('todayBtn'),
  status: createStatusEl(),
};

init();

function init() {
  els.dayPicker.value = currentDate;
  renderDateStamp();
  render();

  els.form.addEventListener('submit', handleAdd);
  els.filters.addEventListener('click', handleFilterClick);
  els.clearDone.addEventListener('click', handleClearDone);
  els.list.addEventListener('click', handleListClick);
  els.list.addEventListener('keydown', handleListKeydown);
  els.list.addEventListener('blur', handleTextBlur, true);
  els.prevDay.addEventListener('click', () => goToDate(addDaysToDateStr(currentDate, -1)));
  els.nextDay.addEventListener('click', () => goToDate(addDaysToDateStr(currentDate, 1)));
  els.todayBtn.addEventListener('click', () => goToDate(todayStr()));
  els.dayPicker.addEventListener('change', () => goToDate(els.dayPicker.value));

  loadTasks();
}

/* ---------------------------------------------------------------------- */
/* API                                                                     */
/* ---------------------------------------------------------------------- */

/** Small fetch wrapper: sends/receives JSON and throws an Error with a readable message. */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server. Is the backend running?");
  }

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON reply — handled below.
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Server error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadTasks() {
  showStatus('Connecting to server… (the first load can take a minute on free hosting)', {
    sticky: true,
  });
  try {
    tasks = await api('GET', '/tasks'); // newest first
    loaded = true;
    hideStatus();
  } catch (err) {
    showStatus(`${err.message} Refresh the page to try again.`, { error: true, sticky: true });
  }
  render();
}

/* ---------------------------------------------------------------------- */
/* Status line (uses the existing ".empty" style, so no CSS change needed) */
/* ---------------------------------------------------------------------- */

function createStatusEl() {
  const p = document.createElement('p');
  p.className = 'empty';
  p.setAttribute('role', 'status');
  p.hidden = true;
  document.getElementById('emptyState').before(p);
  return p;
}

function showStatus(message, { error = false, sticky = false } = {}) {
  clearTimeout(statusTimer);
  els.status.textContent = message;
  els.status.style.color = error ? 'var(--red)' : '';
  els.status.hidden = false;
  if (!sticky) statusTimer = setTimeout(hideStatus, 5000);
}

function hideStatus() {
  clearTimeout(statusTimer);
  els.status.hidden = true;
}

/* ---------------------------------------------------------------------- */
/* Event handlers                                                          */
/* ---------------------------------------------------------------------- */

async function handleAdd(e) {
  e.preventDefault();
  if (!loaded || adding) return;

  const text = els.input.value.trim();
  if (!text) return;

  adding = true;
  try {
    const task = await api('POST', '/tasks', { text, date: currentDate });
    tasks.unshift(task);
    els.input.value = ''; // only cleared once saved, so nothing is lost on failure
    render();
  } catch (err) {
    showStatus(err.message, { error: true });
  } finally {
    adding = false;
  }
}

function handleFilterClick(e) {
  const btn = e.target.closest('.filters__tab');
  if (!btn) return;

  currentFilter = btn.dataset.filter;

  [...els.filters.children].forEach((tab) => {
    const active = tab === btn;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  render();
}

async function handleClearDone() {
  try {
    await api('DELETE', '/tasks?done=true');
    tasks = tasks.filter((t) => !t.done);
    render();
  } catch (err) {
    showStatus(err.message, { error: true });
  }
}

function handleListClick(e) {
  const item = e.target.closest('.task');
  if (!item) return;
  const id = item.dataset.id;

  if (e.target.closest('.task__check')) {
    toggleTask(id);
  } else if (e.target.closest('.task__del')) {
    removeTask(id, item);
  }
}

function handleListKeydown(e) {
  if (e.key !== 'Enter') return;
  if (!e.target.classList.contains('task__text')) return;
  e.preventDefault();
  e.target.blur(); // commit the edit
}

async function handleTextBlur(e) {
  if (renderingList) return; // blur caused by render() rebuilding the list, not by the user
  if (!e.target.classList.contains('task__text')) return;

  const item = e.target.closest('.task');
  const id = item.dataset.id;
  const newText = e.target.textContent.trim();

  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  if (!newText) {
    // Editing down to nothing removes the task, mirroring a crossed-out line.
    removeTask(id, item);
    return;
  }

  if (newText === task.text) return;

  // Show the new text straight away, then save; undo if the server says no.
  const previous = task.text;
  task.text = newText;
  try {
    const updated = await api('PATCH', `/tasks/${encodeURIComponent(id)}`, { text: newText });
    task.text = updated.text;
  } catch (err) {
    task.text = previous;
    render();
    showStatus(err.message, { error: true });
  }
}

/* ---------------------------------------------------------------------- */
/* Mutations                                                                */
/* ---------------------------------------------------------------------- */

async function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  // Flip immediately so the click feels instant, then save; undo on failure.
  const previous = task.done;
  task.done = !previous;
  render();

  try {
    await api('PATCH', `/tasks/${encodeURIComponent(id)}`, { done: task.done });
  } catch (err) {
    task.done = previous;
    render();
    showStatus(err.message, { error: true });
  }
}

function removeTask(id, itemEl) {
  const finish = async () => {
    try {
      await api('DELETE', `/tasks/${encodeURIComponent(id)}`);
      tasks = tasks.filter((t) => t.id !== id);
    } catch (err) {
      if (err.status === 404) {
        // Already gone on the server — just drop it here too.
        tasks = tasks.filter((t) => t.id !== id);
      } else {
        showStatus(err.message, { error: true });
      }
    }
    render();
  };

  if (itemEl && !prefersReducedMotion()) {
    itemEl.classList.add('is-leaving');
    itemEl.addEventListener('animationend', finish, { once: true });
  } else {
    finish();
  }
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                                */
/* ---------------------------------------------------------------------- */

function render() {
  renderingList = true;

  const visible = tasks
    .filter((t) => t.date === currentDate)
    .filter((t) => {
      if (currentFilter === 'active') return !t.done;
      if (currentFilter === 'done') return t.done;
      return true;
    });

  els.list.innerHTML = '';
  visible.forEach((task) => els.list.appendChild(buildTaskEl(task)));

  renderingList = false;

  // Don't show "Blank line…" until we actually know what's on the server.
  els.empty.hidden = !loaded || visible.length > 0;
  els.empty.textContent = emptyMessage();

  const openCount = tasks.filter((t) => !t.done).length;
  els.statCount.textContent = loaded ? `${openCount} open` : '…';

  const doneCount = tasks.length - openCount;
  els.clearDone.hidden = doneCount === 0;
}

function buildTaskEl(task) {
  const li = document.createElement('li');
  li.className = 'task' + (task.done ? ' is-done' : '');
  li.dataset.id = task.id;

  li.innerHTML = `
    <button class="task__check" type="button" aria-label="${task.done ? 'Mark open' : 'Mark done'}">
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 4L3.5 6.5L9 1" stroke="#f2e9d3" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="task__text" contenteditable="true" spellcheck="false"></div>
    <button class="task__del" type="button" aria-label="Delete task">×</button>
  `;

  li.querySelector('.task__text').textContent = task.text;
  return li;
}

function emptyMessage() {
  if (currentFilter === 'active') return 'Nothing open. Clean line.';
  if (currentFilter === 'done') return 'Nothing closed yet.';
  return 'Blank line. Add something worth doing.';
}

function renderDateStamp() {
  els.dateStamp.textContent = formatDisplayDate(currentDate);
}

/* ---------------------------------------------------------------------- */
/* Calendar / day navigation                                               */
/* ---------------------------------------------------------------------- */

function todayStr() {
  return toDateStr(new Date());
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysToDateStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  return toDateStr(date);
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const formatted = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return dateStr === todayStr() ? `${formatted} · Today` : formatted;
}

function goToDate(dateStr) {
  if (!dateStr || dateStr === currentDate) return;
  currentDate = dateStr;
  els.dayPicker.value = currentDate;
  renderDateStamp();
  render();
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
