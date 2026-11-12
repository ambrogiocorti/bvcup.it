export function getEl(id) {
  return document.getElementById(id);
}

export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDuration(totalSeconds = 0) {
  const safe = Math.max(0, toNumber(totalSeconds, 0));
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

function ensureToastContainer() {
  let container = document.querySelector('.toast-wrap');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-wrap';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message, type = 'info') {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

export function setHidden(el, shouldHide) {
  if (!el) return;
  el.classList.toggle('hidden', shouldHide);
}

export function sortByName(items, key = 'name') {
  return [...items].sort((a, b) =>
    String(a?.[key] ?? '').localeCompare(String(b?.[key] ?? ''), 'it', {
      sensitivity: 'base',
    })
  );
}

export function medalByRank(index) {
  if (index === 0) return '1°';
  if (index === 1) return '2°';
  if (index === 2) return '3°';
  return String(index + 1);
}

export function buildOptions(items, valueKey = 'id', labelKey = 'name') {
  return items
    .map(
      (item) =>
        `<option value="${escapeHtml(item[valueKey])}">${escapeHtml(item[labelKey])}</option>`
    )
    .join('');
}
