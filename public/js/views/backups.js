/**
 * OpenWrt Manager (openwrt-managor)
 * Backups & TrueNAS Schedules Center View
 * Complete with UCI Inspector & Side-by-Side Diff Viewer Modals
 */

import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { openModal, closeModal, confirmAction } from '../components/modal.js';
import { renderDiff } from '../utils/diff-viewer.js';
import { formatBytes, formatRelativeTime, escapeHtml } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

export function renderBackups(container) {
  const { backups, health } = store.state;

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>Backups & TrueNAS Schedules Center</h1>
        <p>Automated ZFS storage archives, SHA-256 integrity validation, and UCI configuration diffing</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-secondary" id="backup-config-sched-btn">
          ${renderIcon('settings', 'icon')} Configure Schedule
        </button>
        <button type="button" class="btn btn-primary" id="backup-run-all-btn">
          ${renderIcon('database', 'icon')} Backup All Fleet Now
        </button>
      </div>
    </div>

    <!-- Storage Status Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; background: var(--color-surface); border: 1px solid var(--color-border); padding: 14px 18px; border-radius: var(--radius-lg); flex-wrap: wrap; gap: 12px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--color-primary-light); color: var(--color-primary); display: flex; align-items: center; justify-content: center;">
          ${renderIcon('database', 'icon')}
        </div>
        <div>
          <div style="font-weight: 600; font-size: 14px;">Storage Target: <span class="font-mono">/backups</span> (TrueNAS ZFS Mount)</div>
          <div style="font-size: 12px; color: var(--color-text-secondary);">Retention Policy: Retain last 30 daily archives per host</div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px; font-size: 13px;">
        <div><strong>${backups.length}</strong> Archives Stored</div>
        <span class="status-pill success">
          <span class="status-dot success"></span>
          ZFS Mount Healthy
        </span>
      </div>
    </div>

    <!-- Backup Schedule Summary Card -->
    <div class="chart-card" style="padding: 16px 20px;">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="status-pill online">Active Schedule</span>
            <span style="font-weight: 600; font-size: 14px;">Nightly Fleet Snapshot</span>
          </div>
          <div style="font-size: 12.5px; color: var(--color-text-secondary); margin-top: 4px;">
            Cron: <code style="background:var(--color-surface-elevated); padding:2px 6px; border-radius:4px; font-family:var(--font-mono);">0 3 * * *</code> (Every day at 03:00 UTC) • Next run in ~13 hours
          </div>
        </div>
        <button type="button" class="btn btn-secondary" id="backup-run-sched-now">
          ${renderIcon('zap', 'icon')} Run Schedule Now
        </button>
      </div>
    </div>

    <!-- Backup History Table -->
    <div class="table-container">
      <div class="table-toolbar">
        <h2 style="font-size: 15px; font-weight: 600;">Backup Archives History (${backups.length})</h2>
      </div>

      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Host Name</th>
              <th>Archive Filename</th>
              <th>Size</th>
              <th>SHA-256 Checksum</th>
              <th>Status</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${backups.length > 0 ? backups.map(b => renderBackupRow(b)).join('') : `
              <tr>
                <td colspan="7" style="text-align: center; padding: 32px;">
                  <div class="empty-state">
                    <div class="empty-state-title">No Backup Archives Found</div>
                    <div class="empty-state-desc">Click "Backup All Fleet Now" above to create your first configuration snapshots.</div>
                  </div>
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Global Modals for Backups View -->
    ${renderBackupModals()}
  `;

  // Attach Backup All
  container.querySelector('#backup-run-all-btn')?.addEventListener('click', async () => {
    try {
      toast.info('Backup Queued', 'Creating snapshots for all fleet nodes...');
      await api.runBackup('all');
      toast.success('Backup Successful', 'New configuration archives generated in /backups.');
      store.poll();
    } catch (err) {
      toast.error('Backup Failed', err.message);
    }
  });

  // Attach Run Schedule
  container.querySelector('#backup-run-sched-now')?.addEventListener('click', async () => {
    try {
      toast.info('Running Schedule', 'Executing nightly backup schedule...');
      await api.runBackup('all');
      toast.success('Schedule Finished', 'Automated backups completed and validated.');
      store.poll();
    } catch (err) {
      toast.error('Execution Failed', err.message);
    }
  });

  // Attach Schedule Configuration Modal
  container.querySelector('#backup-config-sched-btn')?.addEventListener('click', () => {
    openModal('schedule-config-dialog');
  });

  // Attach Save Schedule Handler
  container.querySelector('#sched-save-btn')?.addEventListener('click', async () => {
    const cron = container.querySelector('#sched-preset-select')?.value || '0 3 * * *';
    const retention = parseInt(container.querySelector('#sched-retention-input')?.value || '14', 10);
    try {
      await api.updateBackupSchedules({
        schedules: [
          {
            id: 'sched-nightly-fleet',
            name: 'Nightly Fleet Backup',
            cron,
            enabled: true,
            targets: ['all'],
            retentionMaxBackups: retention
          }
        ]
      });
      closeModal('schedule-config-dialog');
      toast.success('Schedule Saved', `Automated backup schedule updated (${cron})`);
      store.poll();
    } catch (err) {
      toast.error('Failed to Save Schedule', err.message);
    }
  });

  // Attach Row Action Buttons: Copy SHA, Inspect Files, Diff, Download, Delete
  container.querySelectorAll('.btn-copy-sha').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sha = btn.getAttribute('data-sha');
      if (sha) {
        navigator.clipboard.writeText(sha);
        toast.info('Copied Checksum', `SHA-256: ${sha.slice(0, 16)}...`);
      }
    });
  });

  container.querySelectorAll('.btn-inspect-files').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const backupId = btn.getAttribute('data-backup-id');
      await openFilesInspectorModal(backupId);
    });
  });

  container.querySelectorAll('.btn-diff-backup').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const backupId = btn.getAttribute('data-backup-id');
      await openDiffViewerModal(backupId);
    });
  });

  container.querySelectorAll('.btn-delete-backup').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const backupId = btn.getAttribute('data-backup-id');
      const confirmed = await confirmAction({
        title: 'Delete Backup Archive',
        message: `Are you sure you want to permanently delete archive ${backupId}? This action unlinks the .tar.gz archive and metadata from TrueNAS storage.`,
        confirmLabel: 'Delete Archive',
        isDestructive: true
      });

      if (confirmed) {
        try {
          await api.deleteBackup(backupId);
          toast.success('Archive Deleted', `Deleted ${backupId}`);
          store.poll();
        } catch (err) {
          toast.error('Delete Failed', err.message);
        }
      }
    });
  });
}

function renderBackupRow(b) {
  const shortSha = b.sha256 ? `${b.sha256.slice(0, 10)}...` : 'N/A';
  return `
    <tr data-backup-id="${b.id}">
      <td>
        <div style="font-weight: 600;">${formatRelativeTime(b.timestamp)}</div>
        <div style="font-size: 11px; color: var(--color-text-muted);">${new Date(b.timestamp).toLocaleString()}</div>
      </td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(b.hostName || b.hostId)}</div>
        <div style="font-size: 11px; color: var(--color-text-muted);">${escapeHtml(b.openwrtVersion || 'OpenWrt')}</div>
      </td>
      <td>
        <div class="font-mono" style="font-size: 12px;">${escapeHtml(b.filename || b.id + '.tar.gz')}</div>
      </td>
      <td>
        <span class="font-mono">${formatBytes(b.sizeBytes || 42000)}</span>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 6px;">
          <code class="font-mono" style="font-size: 11px; background: var(--color-surface-elevated); padding: 2px 4px; border-radius: 4px;">${shortSha}</code>
          <button type="button" class="btn-icon btn-copy-sha" data-sha="${b.sha256}" style="width: 22px; height: 22px;" title="Copy SHA-256">
            ${renderIcon('copy', 'icon')}
          </button>
        </div>
      </td>
      <td>
        <span class="status-pill ${b.status === 'success' ? 'success' : 'danger'}">
          ${b.status === 'success' ? 'Verified' : 'Failed'}
        </span>
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <button type="button" class="btn btn-secondary btn-inspect-files" data-backup-id="${b.id}" style="padding: 4px 8px; font-size: 11.5px;">
          ${renderIcon('fileText', 'icon')} Files
        </button>
        <button type="button" class="btn btn-secondary btn-diff-backup" data-backup-id="${b.id}" style="padding: 4px 8px; font-size: 11.5px;">
          ${renderIcon('diff', 'icon')} Diff
        </button>
        <a href="${api.getBackupDownloadUrl(b.id)}" download class="btn btn-secondary" style="padding: 4px 8px; font-size: 11.5px;" title="Download .tar.gz">
          ${renderIcon('download', 'icon')}
        </a>
        <button type="button" class="btn-icon btn-delete-backup" data-backup-id="${b.id}" style="width: 26px; height: 26px; color: var(--color-danger);" title="Delete archive">
          ${renderIcon('trash', 'icon')}
        </button>
      </td>
    </tr>
  `;
}

function renderBackupModals() {
  return `
    <!-- UCI Config Files Inspector Modal -->
    <dialog id="backup-files-dialog" aria-labelledby="files-modal-title">
      <div class="modal-header">
        <h2 id="files-modal-title" class="modal-title">Inspect UCI Configuration Files</h2>
        <button type="button" class="btn-icon" onclick="document.getElementById('backup-files-dialog').close()" aria-label="Close">
          ${renderIcon('x', 'icon')}
        </button>
      </div>
      <div class="modal-body" style="gap: 16px;">
        <div style="font-size: 12.5px; color: var(--color-text-secondary);" id="inspector-backup-meta"></div>
        <div style="display: grid; grid-template-columns: 200px 1fr; gap: 12px; height: 400px; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden;">
          <div id="inspector-files-list" style="overflow-y: auto; background: var(--color-surface-elevated); padding: 8px; border-right: 1px solid var(--color-border); display: flex; flex-direction: column; gap: 4px;"></div>
          <div id="inspector-file-preview" style="overflow-y: auto; padding: 12px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; background: var(--color-canvas);">
            Select a configuration file on the left to inspect its contents.
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('backup-files-dialog').close()">Close</button>
      </div>
    </dialog>

    <!-- Side-by-Side UCI Diff Viewer Modal -->
    <dialog id="backup-diff-dialog" aria-labelledby="diff-modal-title" style="max-width: 860px;">
      <div class="modal-header">
        <h2 id="diff-modal-title" class="modal-title">Side-by-Side UCI Configuration Diff</h2>
        <button type="button" class="btn-icon" onclick="document.getElementById('backup-diff-dialog').close()" aria-label="Close">
          ${renderIcon('x', 'icon')}
        </button>
      </div>
      <div class="modal-body" style="gap: 12px;">
        <div class="diff-file-selector" style="border-radius: var(--radius-md);">
          <label style="font-weight: 600; font-size: 12px;">Compare With:</label>
          <select id="diff-target-backup-select" class="form-select" style="flex: 1; font-size: 12px;"></select>
          <label style="font-weight: 600; font-size: 12px; margin-left: 8px;">Config File:</label>
          <select id="diff-file-select" class="form-select" style="font-size: 12px;">
            <option value="etc/config/network">etc/config/network</option>
            <option value="etc/config/wireless">etc/config/wireless</option>
            <option value="etc/config/firewall">etc/config/firewall</option>
            <option value="etc/config/dhcp">etc/config/dhcp</option>
            <option value="etc/config/system">etc/config/system</option>
          </select>
        </div>
        <div id="diff-output-mount"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('backup-diff-dialog').close()">Close Diff</button>
      </div>
    </dialog>

    <!-- Schedule Config Modal -->
    <dialog id="schedule-config-dialog" aria-labelledby="sched-modal-title">
      <div class="modal-header">
        <h2 id="sched-modal-title" class="modal-title">Configure TrueNAS Automated Backup Schedule</h2>
        <button type="button" class="btn-icon" onclick="document.getElementById('schedule-config-dialog').close()" aria-label="Close">
          ${renderIcon('x', 'icon')}
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Schedule Preset</label>
          <select id="sched-preset-select" class="form-select">
            <option value="0 3 * * *">Daily at 03:00 UTC (Recommended)</option>
            <option value="0 4 * * 0">Weekly (Sundays at 04:00 UTC)</option>
            <option value="0 */12 * * *">Twice Daily (Every 12 hours)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Retention Count (Max archives per host)</label>
          <input type="number" id="sched-retention-input" class="form-input" min="2" max="100" value="14" />
          <span class="form-hint">TrueNAS will automatically prune archives older than this limit while protecting the 2 most recent snapshots.</span>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('schedule-config-dialog').close()">Cancel</button>
        <button type="button" class="btn btn-primary" id="sched-save-btn">Save Schedule</button>
      </div>
    </dialog>
  `;
}

async function openFilesInspectorModal(backupId) {
  const dialog = document.getElementById('backup-files-dialog');
  if (!dialog) return;

  const metaEl = dialog.querySelector('#inspector-backup-meta');
  const filesListEl = dialog.querySelector('#inspector-files-list');
  const previewEl = dialog.querySelector('#inspector-file-preview');

  metaEl.textContent = `Streaming files from archive ${backupId}...`;
  filesListEl.innerHTML = `<div class="shimmer skeleton-text"></div>`;
  previewEl.textContent = `Loading...`;

  openModal(dialog);

  try {
    const res = await api.getBackupFiles(backupId);
    metaEl.textContent = `Archive: ${backupId} • ${res.files?.length || 0} configuration files inside`;

    if (!res.files || res.files.length === 0) {
      filesListEl.innerHTML = `<div style="font-size: 12px; color: var(--color-text-muted);">No files found</div>`;
      previewEl.textContent = '';
      return;
    }

    filesListEl.innerHTML = res.files.map(f => `
      <button type="button" class="btn-ghost file-item-btn" data-path="${escapeHtml(f.path)}" style="text-align: left; padding: 6px 8px; font-size: 11.5px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        ${escapeHtml(f.path)}
      </button>
    `).join('');

    const fileBtns = filesListEl.querySelectorAll('.file-item-btn');
    fileBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        fileBtns.forEach(b => b.style.background = 'transparent');
        btn.style.background = 'var(--color-surface-hover)';
        const path = btn.getAttribute('data-path');
        previewEl.textContent = `Fetching ${path}...`;
        try {
          const contentRes = await api.getBackupFileContent(backupId, path);
          previewEl.textContent = typeof contentRes === 'string' ? contentRes : (contentRes?.content || JSON.stringify(contentRes, null, 2));
        } catch (err) {
          previewEl.textContent = `Error reading file: ${err.message}`;
        }
      });
    });

    // Auto-select first file
    if (fileBtns.length > 0) {
      fileBtns[0].click();
    }
  } catch (err) {
    metaEl.textContent = `Failed to stream archive: ${err.message}`;
    filesListEl.innerHTML = '';
    previewEl.textContent = err.message;
  }
}

async function openDiffViewerModal(sourceBackupId) {
  const dialog = document.getElementById('backup-diff-dialog');
  if (!dialog) return;

  const { backups } = store.state;
  const targetSelect = dialog.querySelector('#diff-target-backup-select');
  const fileSelect = dialog.querySelector('#diff-file-select');
  const outputMount = dialog.querySelector('#diff-output-mount');

  // Populate comparison targets (all other backups)
  const otherBackups = backups.filter(b => b.id !== sourceBackupId);
  if (otherBackups.length === 0) {
    targetSelect.innerHTML = `<option value="">No other backups available for comparison</option>`;
  } else {
    targetSelect.innerHTML = otherBackups.map(b => `
      <option value="${escapeHtml(b.id)}">${escapeHtml(b.hostName || b.hostId)} (${formatRelativeTime(b.timestamp)}) - ${escapeHtml(b.id)}</option>
    `).join('');
  }

  const loadDiff = async () => {
    const targetId = targetSelect.value;
    const file = fileSelect.value;
    if (!targetId) {
      outputMount.innerHTML = `<div class="empty-state"><p class="empty-state-desc">Create at least two backups to view side-by-side configuration differences.</p></div>`;
      return;
    }

    outputMount.innerHTML = `<div class="shimmer" style="height: 200px; border-radius: var(--radius-md);"></div>`;
    try {
      const diffData = await api.getBackupDiff(sourceBackupId, targetId, file);
      outputMount.innerHTML = renderDiff(diffData);
    } catch (err) {
      outputMount.innerHTML = `<div class="empty-state"><p class="empty-state-desc" style="color:var(--color-danger);">Diff failed: ${escapeHtml(err.message)}</p></div>`;
    }
  };

  targetSelect.onchange = loadDiff;
  fileSelect.onchange = loadDiff;

  openModal(dialog);
  loadDiff();
}
