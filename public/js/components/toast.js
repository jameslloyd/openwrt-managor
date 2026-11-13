/**
 * OpenWrt Manager (openwrt-managor)
 * Accessible Toast Notification Dispatcher
 */

import { renderIcon } from '../utils/icons.js';
import { escapeHtml } from '../utils/formatters.js';

let container = null;

function getContainer() {
  if (!container) {
    container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('aria-atomic', 'true');
      document.body.appendChild(container);
    }
  }
  return container;
}

function announceSr(message, priority = 'polite') {
  const el = document.getElementById(`sr-announcer-${priority}`);
  if (el) {
    el.textContent = message;
  }
}

export function showToast({ title, message, type = 'info', duration, action }) {
  const c = getContainer();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'danger' ? 'alert' : 'status');

  let iconName = 'alertCircle';
  if (type === 'success') iconName = 'check';
  else if (type === 'warning') iconName = 'alertTriangle';
  else if (type === 'danger') iconName = 'alertCircle';
  else if (type === 'info') iconName = 'activity';

  let actionHtml = '';
  if (action && action.label) {
    actionHtml = `<button type="button" class="btn btn-ghost" style="padding: 2px 6px; font-size: 11px; margin-top: 4px; text-decoration: underline;">${action.label}</button>`;
  }

  toast.innerHTML = `
    <div style="flex-shrink: 0; color: currentColor;">
      ${renderIcon(iconName, 'icon')}
    </div>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ''}
      ${actionHtml}
    </div>
    <button type="button" class="toast-close" aria-label="Close notification">
      ${renderIcon('x', 'icon')}
    </button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => dismiss(toast));

  if (action && action.onClick) {
    const actBtn = toast.querySelector('.toast-content button');
    if (actBtn) {
      actBtn.addEventListener('click', () => {
        action.onClick();
        dismiss(toast);
      });
    }
  }

  c.appendChild(toast);
  announceSr(`${title}: ${message || ''}`, type === 'danger' ? 'assertive' : 'polite');

  // Determine auto-dismiss timeout
  let timeout = duration;
  if (timeout === undefined) {
    if (type === 'success' || type === 'info') timeout = 4000;
    else if (type === 'warning') timeout = 8000;
    else timeout = 0; // Persistent for danger/error
  }

  if (timeout > 0) {
    setTimeout(() => dismiss(toast), timeout);
  }

  return toast;
}

function dismiss(toast) {
  if (!toast || !toast.parentNode) return;
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(8px)';
  toast.style.transition = 'all 0.2s ease-in';
  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 200);
}

export const toast = {
  success: (title, message, options = {}) => showToast({ title, message, type: 'success', ...options }),
  warning: (title, message, options = {}) => showToast({ title, message, type: 'warning', ...options }),
  error: (title, message, options = {}) => showToast({ title, message, type: 'danger', ...options }),
  info: (title, message, options = {}) => showToast({ title, message, type: 'info', ...options })
};

export default toast;
