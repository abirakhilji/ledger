/**
 * Ledger — a small, dependency-free task tracker.
 *
 * State lives in localStorage under the key below, so tasks survive a
 * page reload but stay local to the browser they were created in.
 * No build step, no framework — just DOM APIs.
 */

const STORAGE_KEY = 'ledger.tasks.v1';

/** @typedef {{ id: string, text: string, done: boolean, createdAt: number }} Task */

/** @type {Task[]} */
let tasks = loadTasks();
let currentFilter = 'all'; // 'all' | 'active' | 'done'

const els = {
  form: document.getElementById('entryForm'),
  input: document.getElementById('entryInput'),
  list: document.getElementById('list'),
  empty: document.getElementById('emptyState'),
  filters: document.getElementById('filters'),
  statCount: document.getElementById('statCount'),
  clearDone: document.getElementById('clearDone'),
  dateStamp: document.getElementById('dateStamp'),
};

init();

function init() {
  renderDateStamp();
  render();

  els.form.addEventListener('submit', handleAdd);
  els.filters.addEventListener('click', handleFilterClick);
  els.clearDone.addEventListener('click', handleClearDone);
  els.list.addEventListener('click', handleListClick);
  els.list.addEventListener('keydown', handleListKeydown);
  els.list.addEventListener('blur', handleTextBlur, true);
}

/* ---------------------------------------------------------------------- */
/* Storage                                                                 */
/* ---------------------------------------------------------------------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    // Corrupt or blocked storage shouldn't crash the app.
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Storage can be full or disabled (private browsing); the app still
    // works for the current session, it just won't persist.
  }
}

/* ---------------------------------------------------------------------- */
/* Event handlers                                                          */
/* ---------------------------------------------------------------------- */

function handleAdd(e) {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;

  tasks.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    text,
    done: false,
    createdAt: Date.now(),
  });

  els.input.value = '';
  saveTasks();
  render();
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

function handleClearDone() {
  tasks = tasks.filter((t) => !t.done);
  saveTasks();
  render();
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

function handleTextBlur(e) {
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

  if (newText !== task.text) {
    task.text = newText;
    saveTasks();
  }
}

/* ---------------------------------------------------------------------- */
/* Mutations                                                                */
/* ---------------------------------------------------------------------- */

function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.done = !task.done;
  saveTasks();
  render();
}

function removeTask(id, itemEl) {
  const finish = () => {
    tasks = tasks.filter((t) => t.id !== id);
    saveTasks();
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
  const visible = tasks.filter((t) => {
    if (currentFilter === 'active') return !t.done;
    if (currentFilter === 'done') return t.done;
    return true;
  });

  els.list.innerHTML = '';
  visible.forEach((task) => els.list.appendChild(buildTaskEl(task)));

  els.empty.hidden = visible.length > 0;
  els.empty.textContent = emptyMessage();

  const openCount = tasks.filter((t) => !t.done).length;
  els.statCount.textContent = `${openCount} open`;

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
  const formatted = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  els.dateStamp.textContent = formatted;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
