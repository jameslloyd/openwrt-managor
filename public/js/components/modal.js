/**
 * OpenWrt Manager (openwrt-managor)
 * Accessible Native <dialog> Modal Controller
 * Compliant with modern-web-guidance (closedby="any", showModal, light-dismiss fallback)
 */

import { escapeHtml } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

let lastActiveTrigger = null;
let paneThemeDelegationBound = false;

const PANE_THEME_STORAGE_KEY = 'editing-pane-theme';

export function getPaneTheme() {
  try {
    const saved = localStorage.getItem(PANE_THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    const globalTheme = localStorage.getItem('color-scheme');
    if (globalTheme === 'light' || globalTheme === 'dark') return globalTheme;
  } catch {}
  const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="color-scheme"]') : null;
  if (meta && meta.content === 'light') return 'light';
  return 'dark';
}

export function syncPaneTheme(targetEl = null) {
  if (typeof document === 'undefined') return;
  ensurePaneThemeDelegation();
  const theme = getPaneTheme();
  const panes = targetEl
    ? [targetEl]
    : Array.from(document.querySelectorAll('dialog, .inspector-drawer'));

  panes.forEach((pane) => {
    if (!pane) return;
    pane.setAttribute('data-pane-theme', theme);
    pane.querySelectorAll('.pane-theme-btn[data-pane-theme-choice]').forEach((btn) => {
      const isMatch = btn.getAttribute('data-pane-theme-choice') === theme;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
    });
  });
}

export function setPaneTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem(PANE_THEME_STORAGE_KEY, normalized);
  } catch {}
  syncPaneTheme();
}

function ensurePaneThemeDelegation() {
  if (paneThemeDelegationBound || typeof document === 'undefined') return;
  paneThemeDelegationBound = true;
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.pane-theme-btn[data-pane-theme-choice]');
    if (!btn) return;
    e.preventDefault();
    const choice = btn.getAttribute('data-pane-theme-choice');
    if (choice === 'light' || choice === 'dark') {
      setPaneTheme(choice);
    }
  });
}

export function renderPaneThemeToggle() {
  ensurePaneThemeDelegation();
  const current = getPaneTheme();
  return `
    <div class="pane-theme-switcher" role="group" aria-label="Editing pane color theme">
      <button
        type="button"
        class="pane-theme-btn ${current === 'light' ? 'active' : ''}"
        data-pane-theme-choice="light"
        aria-pressed="${current === 'light' ? 'true' : 'false'}"
        title="Light theme for editing pane"
      >
        ${renderIcon('sun', 'icon icon-sm')}
        <span>Light</span>
      </button>
      <button
        type="button"
        class="pane-theme-btn ${current === 'dark' ? 'active' : ''}"
        data-pane-theme-choice="dark"
        aria-pressed="${current === 'dark' ? 'true' : 'false'}"
        title="Dark theme for editing pane"
      >
        ${renderIcon('moon', 'icon icon-sm')}
        <span>Dark</span>
      </button>
    </div>
  `;
}

export function setupDialogLightDismiss(dialog) {
  if (!dialog) return;

  // Set closedby="any" attribute as progressive enhancement
  dialog.setAttribute('closedby', 'any');

  // Fallback for browsers without native closedby support (e.g. Safari)
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      // 1. When clicking the backdrop, the event target is the dialog element itself
      if (event.target !== dialog) return;

      // 2. Check if the click coordinates fall within the dialog content box
      const rect = dialog.getBoundingClientRect();
      const isInsideContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );

      if (isInsideContent) return;

      // 3. Click was outside content area on the backdrop: close modal
      dialog.close('dismiss');
    });
  }

  // Handle close event to reset returnValue
  dialog.addEventListener('close', () => {
    dialog.returnValue = '';
    if (lastActiveTrigger && typeof lastActiveTrigger.focus === 'function') {
      try {
        lastActiveTrigger.focus();
      } catch (e) {
        // Ignore if element is unmounted
      }
    }
  });
}

export function openModal(dialogOrId, triggerEl = null) {
  const dialog = typeof dialogOrId === 'string' ? document.getElementById(dialogOrId) : dialogOrId;
  if (!dialog || typeof dialog.showModal !== 'function') return;

  lastActiveTrigger = triggerEl || document.activeElement;
  setupDialogLightDismiss(dialog);
  syncPaneTheme(dialog);

  try {
    dialog.showModal();
  } catch (err) {
    console.warn('Error opening modal:', err);
  }
}

export function closeModal(dialogOrId, returnValue = '') {
  const dialog = typeof dialogOrId === 'string' ? document.getElementById(dialogOrId) : dialogOrId;
  if (!dialog || !dialog.open) return;
  dialog.close(returnValue);
}

export function confirmAction({ title, message, confirmLabel = 'Confirm', isDestructive = false }) {
  return new Promise((resolve) => {
    let dialog = document.getElementById('global-confirm-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'global-confirm-dialog';
      dialog.setAttribute('aria-labelledby', 'confirm-modal-title');
      document.body.appendChild(dialog);
    }

    dialog.innerHTML = `
      <form method="dialog" class="modal-content">
        <div class="modal-header">
          <h2 id="confirm-modal-title" class="modal-title">${escapeHtml(title)}</h2>
          <div class="modal-header-actions">
            ${renderPaneThemeToggle()}
            <button type="button" class="btn-icon modal-close-btn" aria-label="Close dialog">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="modal-body">
          <p style="font-size: 13.5px; line-height: 1.5; color: var(--color-text-secondary);">${escapeHtml(message)}</p>
        </div>
        <div class="modal-footer">
          <button type="button" value="cancel" class="btn btn-secondary" autofocus>Cancel</button>
          <button type="button" value="confirm" class="btn ${isDestructive ? 'btn-danger' : 'btn-primary'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `;

    const cancelBtn = dialog.querySelector('button[value="cancel"]');
    const confirmBtn = dialog.querySelector('button[value="confirm"]');
    const closeBtn = dialog.querySelector('.modal-close-btn');

    const handleConfirm = () => {
      dialog.close('confirm');
      resolve(true);
    };

    const handleCancel = () => {
      dialog.close('cancel');
      resolve(false);
    };

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);

    openModal(dialog);
  });
}
