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

const CRON_PRESETS = [
  { value: '0 3 * * *', label: 'Daily at 03:00 UTC (Recommended)', desc: 'Every day at 03:00 UTC' },
  { value: '0 0 * * *', label: 'Daily at 00:00 UTC (Midnight)', desc: 'Every day at 00:00 UTC' },
  { value: '0 */12 * * *', label: 'Twice Daily (Every 12 hours)', desc: 'Every 12 hours at :00' },
  { value: '0 */6 * * *', label: 'Every 6 Hours', desc: 'Every 6 hours at :00' },
  { value: '0 * * * *', label: 'Hourly (Every hour)', desc: 'Every hour at :00' },
  { value: '0 4 * * 0', label: 'Weekly (Sundays at 04:00 UTC)', desc: 'Sundays at 04:00 UTC' }
];

function describeCron(cronExpr) {
  const clean = String(cronExpr || '0 3 * * *').trim();
  const preset = CRON_PRESETS.find((p) => p.value === clean);
  if (preset) return preset.desc;

  const parts = clean.split(/\s+/);
  if (parts.length >= 5) {
    const [min, hour, dom, month, dow] = parts;
    if (dom === '*' && month === '*' && dow === '*') {
      if (hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
      if (hour === '*' && min.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
      if (/^\d+$/.test(hour) && /^\d+$/.test(min)) {
        return `Every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC`;
      }
    }
  }
  return `Custom schedule (${clean})`;
}

function formatNextRunText(nextRunIso) {
  if (!nextRunIso) return 'Scheduled';
  const diffMs = new Date(nextRunIso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return 'Scheduled';
  if (diffMs <= 60000) return 'Next run due Within 1 minute';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `Next run in ~${mins} min${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Next run in ~${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `Next run in ~${days} day${days === 1 ? '' : 's'}`;
}

export function renderBackups(container) {
  const { backups, schedules, settings, health } = store.state;
  const activeSched = (schedules && schedules[0]) || {
    id: 'sched-nightly-fleet',
    name: 'Nightly Fleet Backup',
    cron: '0 3 * * *',
    enabled: true,
    targets: ['all'],
    retentionMaxBackups: settings?.retention?.maxBackupsPerHost || 18,
    keepDaily: settings?.retention?.keepDaily ?? 7,
    keepWeekly: settings?.retention?.keepWeekly ?? 4,
    keepMonthly: settings?.retention?.keepMonthly ?? 6,
    keepYearly: settings?.retention?.keepYearly ?? 1,
    lastRun: null,
    nextRun: null
  };
  const isScheduleEnabled = activeSched.enabled !== false;
  const keepDaily = activeSched.keepDaily ?? settings?.retention?.keepDaily ?? 7;
  const keepWeekly = activeSched.keepWeekly ?? settings?.retention?.keepWeekly ?? 4;
  const keepMonthly = activeSched.keepMonthly ?? settings?.retention?.keepMonthly ?? 6;
  const keepYearly = activeSched.keepYearly ?? settings?.retention?.keepYearly ?? 1;
  const retentionCount = keepDaily + keepWeekly + keepMonthly + keepYearly;
  const backupDirPath = health?.storage?.backupDir || '/backups';

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>Backups & TrueNAS Schedules Center</h1>
        <p>Automated ZFS storage archives, SHA-256 integrity validation, and UCI configuration diffing</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-secondary" id="backup-config-sched-btn">
          ${renderIcon('clock', 'icon')} Configure Schedule
        </button>
        <button type="button" class="btn btn-primary" id="backup-run-all-btn">
          ${renderIcon('database', 'icon')} Backup All Fleet Now
        </button>
      </div>
    </div>

    <!-- Storage Status Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; background: var(--color-surface); border: 1px solid var(--color-border); padding: 14px 18px; border-radius: var(--radius-lg); flex-wrap: wrap; gap: 12px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--color-primary-light); color: var(--color-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
          ${renderIcon('database', 'icon icon-md')}
        </div>
        <div>
          <div style="font-weight: 600; font-size: 14px;">Storage Target: <span class="font-mono">${escapeHtml(backupDirPath)}</span> (TrueNAS ZFS Mount)</div>
          <div style="font-size: 12px; color: var(--color-text-secondary);">Retention Policy: Keep newest <strong>${keepDaily} Daily</strong>, <strong>${keepWeekly} Weekly</strong>, <strong>${keepMonthly} Monthly</strong>, and <strong>${keepYearly} Yearly</strong> config backups per host</div>
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
            <span class="status-pill ${isScheduleEnabled ? 'online' : 'warning'}">
              <span class="status-dot ${isScheduleEnabled ? 'online' : 'warning'}"></span>
              ${isScheduleEnabled ? 'Active Schedule' : 'Schedule Paused'}
            </span>
            <span style="font-weight: 600; font-size: 14px;">${escapeHtml(activeSched.name || 'Nightly Fleet Backup')}</span>
          </div>
          <div style="font-size: 12.5px; color: var(--color-text-secondary); margin-top: 6px;">
            Cron: <code style="background:var(--color-surface-elevated); padding:2px 6px; border-radius:4px; font-family:var(--font-mono);">${escapeHtml(activeSched.cron)}</code> (${escapeHtml(describeCron(activeSched.cron))}) • ${isScheduleEnabled ? formatNextRunText(activeSched.nextRun) : 'Automated runs paused'}${activeSched.lastRun ? ` • Last run ${formatRelativeTime(activeSched.lastRun)}` : ''}
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
              <th class="col-sha">SHA-256 Checksum</th>
              <th>Status</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${backups.length > 0 ? backups.map(b => renderBackupRow(b)).join('') : `
              <tr>
                <td colspan="7" style="text-align: center; padding: 32px;">
                  <div class="empty-state">
                    <div class="empty-state-icon">${renderIcon('database', 'icon')}</div>
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
    ${renderBackupModals(activeSched, retentionCount)}
  `;

  // Attach Backup All
  container.querySelector('#backup-run-all-btn')?.addEventListener('click', async () => {
    try {
      toast.info('Backup Queued', 'Creating snapshots for all fleet nodes...');
      await api.runBackup('all');
      toast.success('Backup Successful', 'New configuration archives generated in /backups.');
      await store.poll(true);
    } catch (err) {
      toast.error('Backup Failed', err.message);
    }
  });

  // Attach Run Schedule
  container.querySelector('#backup-run-sched-now')?.addEventListener('click', async () => {
    try {
      toast.info('Running Schedule', `Executing "${activeSched.name || 'Nightly Fleet Backup'}"...`);
      await api.runBackupSchedule(activeSched.id || 'sched-nightly-fleet');
      toast.success('Schedule Finished', 'Automated backups completed and validated.');
      await store.poll(true);
    } catch (err) {
      toast.error('Execution Failed', err.message);
    }
  });

  // Attach Schedule Configuration Modal
  container.querySelector('#backup-config-sched-btn')?.addEventListener('click', () => {
    const presetSelect = container.querySelector('#sched-preset-select');
    const nameInput = container.querySelector('#sched-name-input');
    const dailyInput = container.querySelector('#sched-keep-daily-input');
    const weeklyInput = container.querySelector('#sched-keep-weekly-input');
    const monthlyInput = container.querySelector('#sched-keep-monthly-input');
    const yearlyInput = container.querySelector('#sched-keep-yearly-input');
    const enabledCheckbox = container.querySelector('#sched-enabled-checkbox');
    if (presetSelect) presetSelect.value = activeSched.cron || '0 3 * * *';
    if (nameInput) nameInput.value = activeSched.name || 'Nightly Fleet Backup';
    if (dailyInput) dailyInput.value = String(keepDaily);
    if (weeklyInput) weeklyInput.value = String(keepWeekly);
    if (monthlyInput) monthlyInput.value = String(keepMonthly);
    if (yearlyInput) yearlyInput.value = String(keepYearly);
    if (enabledCheckbox) enabledCheckbox.checked = isScheduleEnabled;
    openModal('schedule-config-dialog');
  });

  // Attach Save Schedule Handler
  container.querySelector('#sched-save-btn')?.addEventListener('click', async () => {
    const cron = container.querySelector('#sched-preset-select')?.value || '0 3 * * *';
    const name = (container.querySelector('#sched-name-input')?.value || 'Nightly Fleet Backup').trim();
    const newDaily = parseInt(container.querySelector('#sched-keep-daily-input')?.value || '7', 10);
    const newWeekly = parseInt(container.querySelector('#sched-keep-weekly-input')?.value || '4', 10);
    const newMonthly = parseInt(container.querySelector('#sched-keep-monthly-input')?.value || '6', 10);
    const newYearly = parseInt(container.querySelector('#sched-keep-yearly-input')?.value || '1', 10);
    const safeDaily = Number.isFinite(newDaily) ? Math.max(0, newDaily) : 7;
    const safeWeekly = Number.isFinite(newWeekly) ? Math.max(0, newWeekly) : 4;
    const safeMonthly = Number.isFinite(newMonthly) ? Math.max(0, newMonthly) : 6;
    const safeYearly = Number.isFinite(newYearly) ? Math.max(0, newYearly) : 1;
    const retention = safeDaily + safeWeekly + safeMonthly + safeYearly;
    const enabled = container.querySelector('#sched-enabled-checkbox')
      ? Boolean(container.querySelector('#sched-enabled-checkbox').checked)
      : true;

    try {
      const res = await api.updateBackupSchedules({
        schedules: [
          {
            id: activeSched.id || 'sched-nightly-fleet',
            name: name || 'Nightly Fleet Backup',
            cron,
            enabled,
            targets: activeSched.targets || ['all'],
            retentionMaxBackups: retention,
            keepDaily: safeDaily,
            keepWeekly: safeWeekly,
            keepMonthly: safeMonthly,
            keepYearly: safeYearly,
          }
        ]
      });
      closeModal('schedule-config-dialog');
      const updatedSchedules = res?.schedules || [];
      store.setState({
        schedules: updatedSchedules,
        settings: store.state.settings
          ? {
              ...store.state.settings,
              retention: {
                ...(store.state.settings.retention || {}),
                maxBackupsPerHost: updatedSchedules[0]?.retentionMaxBackups || retention,
                keepDaily: safeDaily,
                keepWeekly: safeWeekly,
                keepMonthly: safeMonthly,
                keepYearly: safeYearly,
              }
            }
          : store.state.settings
      });
      renderBackups(container);
      toast.success('Schedule Saved', `Automated backup schedule updated (${describeCron(cron)})`);
      await store.poll(true);
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
  const tierLabel = b.retentionTier
    ? b.retentionTier.charAt(0).toUpperCase() + b.retentionTier.slice(1)
    : null;
  return `
    <tr data-backup-id="${b.id}">
      <td>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-weight: 600;">${formatRelativeTime(b.timestamp)}</span>
          ${tierLabel ? `<span style="font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: var(--color-primary-light); color: var(--color-primary);">${escapeHtml(tierLabel)}</span>` : ''}
        </div>
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
      <td class="col-sha">
        <div style="display: inline-flex; align-items: center; gap: 6px;">
          <code class="font-mono" style="font-size: 11px; background: var(--color-surface-elevated); padding: 2px 5px; border-radius: 4px;">${shortSha}</code>
          <button type="button" class="btn-icon btn-copy-sha" data-sha="${escapeHtml(b.sha256 || '')}" style="width: 24px; height: 24px;" title="Copy SHA-256" aria-label="Copy SHA-256 checksum">
            ${renderIcon('copy', 'icon icon-sm')}
          </button>
        </div>
      </td>
      <td>
        <span class="status-pill ${b.status === 'success' ? 'success' : 'danger'}">
          <span class="status-dot ${b.status === 'success' ? 'success' : 'danger'}"></span>
          ${b.status === 'success' ? 'Verified' : 'Failed'}
        </span>
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <div style="display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px;">
          <button type="button" class="btn btn-secondary btn-inspect-files" data-backup-id="${escapeHtml(b.id)}" style="height: 28px; padding: 0 10px; font-size: 12px;" title="Inspect UCI configuration files">
            ${renderIcon('fileText', 'icon icon-sm')} Files
          </button>
          <button type="button" class="btn btn-secondary btn-diff-backup" data-backup-id="${escapeHtml(b.id)}" style="height: 28px; padding: 0 10px; font-size: 12px;" title="Compare UCI configuration diff">
            ${renderIcon('diff', 'icon icon-sm')} Diff
          </button>
          <button type="button" class="btn-icon btn-copy-sha" data-sha="${escapeHtml(b.sha256 || '')}" style="width: 28px; height: 28px;" title="Copy SHA-256" aria-label="Copy SHA-256 checksum">
            ${renderIcon('copy', 'icon icon-sm')}
          </button>
          <a href="${api.getBackupDownloadUrl(b.id)}" download class="btn-icon" style="width: 28px; height: 28px; text-decoration: none;" title="Download .tar.gz archive" aria-label="Download backup archive">
            ${renderIcon('download', 'icon icon-sm')}
          </a>
          <button type="button" class="btn-icon btn-delete-backup" data-backup-id="${escapeHtml(b.id)}" style="width: 28px; height: 28px; color: var(--color-danger);" title="Delete archive" aria-label="Delete backup archive">
            ${renderIcon('trash', 'icon icon-sm')}
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderBackupModals(activeSched = {}, retentionCount = 14) {
  const currentCron = activeSched.cron || '0 3 * * *';
  const currentName = activeSched.name || 'Nightly Fleet Backup';
  const isEnabled = activeSched.enabled !== false;
  const hasCustomCron = !CRON_PRESETS.some((p) => p.value === currentCron);
  const presetOptions = [
    ...CRON_PRESETS,
    ...(hasCustomCron ? [{ value: currentCron, label: `Custom (${currentCron})` }] : [])
  ];

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
        <div class="split-pane-files">
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
          <label class="form-label" for="sched-name-input">Schedule Name</label>
          <input type="text" id="sched-name-input" class="form-input" value="${escapeHtml(currentName)}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="sched-preset-select">Schedule Frequency</label>
          <select id="sched-preset-select" class="form-select">
            ${presetOptions.map((opt) => `<option value="${escapeHtml(opt.value)}" ${opt.value === currentCron ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">GFS Retention Policy (Archives kept per host)</label>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
            <div>
              <label class="form-label" for="sched-keep-daily-input" style="font-size: 11px;">Daily</label>
              <input type="number" id="sched-keep-daily-input" class="form-input" min="0" max="365" value="${activeSched.keepDaily ?? 7}" />
            </div>
            <div>
              <label class="form-label" for="sched-keep-weekly-input" style="font-size: 11px;">Weekly</label>
              <input type="number" id="sched-keep-weekly-input" class="form-input" min="0" max="104" value="${activeSched.keepWeekly ?? 4}" />
            </div>
            <div>
              <label class="form-label" for="sched-keep-monthly-input" style="font-size: 11px;">Monthly</label>
              <input type="number" id="sched-keep-monthly-input" class="form-input" min="0" max="120" value="${activeSched.keepMonthly ?? 6}" />
            </div>
            <div>
              <label class="form-label" for="sched-keep-yearly-input" style="font-size: 11px;">Yearly</label>
              <input type="number" id="sched-keep-yearly-input" class="form-input" min="0" max="20" value="${activeSched.keepYearly ?? 1}" />
            </div>
          </div>
          <span class="form-hint">Keeps the newest 7 daily, 4 weekly, 6 monthly, and 1 yearly config backups per host. Backups outside this retention are automatically deleted.</span>
        </div>
        <div class="form-group" style="flex-direction: row; align-items: center; gap: 8px; margin-top: 4px;">
          <input type="checkbox" id="sched-enabled-checkbox" ${isEnabled ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: var(--color-primary);" />
          <label class="form-label" for="sched-enabled-checkbox" style="margin: 0; cursor: pointer;">Enable Automated Scheduled Backups</label>
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
