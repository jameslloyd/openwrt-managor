/**
 * OpenWrt Manager (openwrt-managor)
 * Application Entry Point, Native Hash Router & View Dispatcher
 */

import { store } from './store.js';
import { api } from './api.js';
import { initDrawer, closeDrawer } from './components/drawer.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTopology, updateTopologyData } from './views/topology.js';
import { renderClients, updateClientsData } from './views/clients.js';
import { renderWifi } from './views/wifi.js';
import { renderBackups } from './views/backups.js';
import { renderHosts, openHostUpdatesModal } from './views/hosts.js';
import { renderSettings } from './views/settings.js';
import { toast } from './components/toast.js';
import { confirmAction, openModal, closeModal } from './components/modal.js';
import { renderIcon } from './utils/icons.js';
import { escapeHtml } from './utils/formatters.js';

const routes = {
  dashboard: renderDashboard,
  overview: renderDashboard,
  topology: renderTopology,
  clients: renderClients,
  wifi: renderWifi,
  backups: renderBackups,
  hosts: renderHosts,
  nodes: renderHosts,
  settings: renderSettings
};

function getActiveRoute() {
  const hash = window.location.hash.slice(2).trim(); // remove '#/'
  const [baseRoute] = hash.split('?');
  return baseRoute || 'dashboard';
}

function navigateTo(route) {
  window.location.hash = `#/${route}`;
}

function dispatchView() {
  const route = getActiveRoute();
  const handler = routes[route] || renderDashboard;
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;

  store.setState({ activeView: route });

  // Update navigation sidebar active state
  document.querySelectorAll('.nav-link').forEach(link => {
    const linkRoute = link.getAttribute('data-route');
    if (linkRoute === route || (linkRoute === 'dashboard' && route === 'overview')) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('active');
      link.removeAttribute('aria-current');
    }
  });

  // Synchronize mobile bottom nav active state (M-NAV-1)
  document.querySelectorAll('.mobile-nav-item').forEach(link => {
    const linkRoute = link.getAttribute('data-route');
    if (linkRoute === route || (linkRoute === 'dashboard' && route === 'overview')) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('active');
      link.removeAttribute('aria-current');
    }
  });

  // Render view
  try {
    handler(mainContent);
  } catch (err) {
    console.error(`Error rendering view "${route}":`, err);
    mainContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title" style="color:var(--color-danger);">Error Rendering View</div>
        <div class="empty-state-desc">${err.message}</div>
        <button type="button" class="btn btn-primary" onclick="window.location.hash='#/dashboard'">Return to Dashboard</button>
      </div>
    `;
  }
}

function updateTopBarAndFooter(state) {
  const { health, hosts, clients, lastPollTime } = state;

  // Top Bar System Status Dot & Pill
  const statusPill = document.getElementById('topbar-status-pill');
  if (statusPill) {
    const isHealthy = health?.status === 'healthy';
    statusPill.className = `status-pill ${isHealthy ? 'online' : 'warning'}`;
    statusPill.innerHTML = `
      <span class="status-dot ${isHealthy ? 'online' : 'warning'}"></span>
      ${isHealthy ? 'All Systems Normal' : 'Degraded Connection'}
    `;
  }

  // Top Bar Mode Pill (P1-2)
  const modePill = document.getElementById('topbar-mode-pill');
  if (modePill) {
    const isDemo = Boolean(health?.demoMode);
    modePill.className = `mode-pill ${isDemo ? 'demo' : ''}`;
    modePill.setAttribute('role', 'button');
    modePill.setAttribute('tabindex', '0');
    modePill.setAttribute('aria-label', `Mode: ${isDemo ? 'Demo Mode' : 'TrueNAS Live Mode'}. Click to toggle.`);
    modePill.innerHTML = `
      <span class="status-dot ${isDemo ? 'warning' : 'online'}"></span>
      ${isDemo ? 'Demo Mode (Simulated)' : 'TrueNAS Live Mode'}
    `;
  }

  // Top Bar Storage Mount Meter (P1-3)
  const storageFill = document.getElementById('topbar-storage-bar-fill');
  const storageText = document.getElementById('topbar-storage-status-text');
  const storageMeter = document.getElementById('topbar-storage-meter');
  const storage = health?.storage;
  if (storageMeter && storageFill && storage) {
    const usedPct = storage.usedPct ?? 25;
    storageFill.style.width = `${Math.min(100, Math.max(2, usedPct))}%`;
    storageMeter.setAttribute('aria-valuenow', usedPct);
    if (storageText) {
      storageText.textContent = storage.freeGb ? `${storage.freeGb} GB Free` : 'ZFS Healthy';
    }
  }

  // Footer Status
  const footerConnected = document.getElementById('footer-connected-hosts');
  if (footerConnected) footerConnected.textContent = `${hosts.length} Hosts Online`;

  const footerClients = document.getElementById('footer-active-clients');
  if (footerClients) footerClients.textContent = `${clients.length} Active Devices`;

  const footerPoll = document.getElementById('footer-last-poll');
  if (footerPoll && lastPollTime) {
    footerPoll.textContent = `Last Poll: ${lastPollTime.toLocaleTimeString()}`;
  }

  // Update navigation count badges
  const badgeNodes = document.getElementById('nav-badge-nodes');
  if (badgeNodes) badgeNodes.textContent = hosts.length;

  const badgeClients = document.getElementById('nav-badge-clients');
  if (badgeClients) badgeClients.textContent = clients.length;

  const badgeBackups = document.getElementById('nav-badge-backups');
  if (badgeBackups) badgeBackups.textContent = state.backups?.length || 0;

  // Sidebar Host Fleet Quick List
  const sidebarHosts = document.getElementById('sidebar-hosts-list');
  if (sidebarHosts) {
    sidebarHosts.innerHTML = hosts.map(h => `
      <li>
        <a href="#/hosts" class="sidebar-host-item" title="${escapeHtml((h.name || h.hostname) + ' (' + h.ip + ')')}">
          <span class="sidebar-host-dot status-dot ${h.status === 'online' ? 'online' : 'offline'}"></span>
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(h.name || h.hostname)}</span>
        </a>
      </li>
    `).join('');
  }
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // If modal dialog, drawer, or mobile menu is open, suppress global shortcuts
    if (document.querySelector('dialog[open]') || document.querySelector('.inspector-drawer.open') || document.querySelector('.sidebar.mobile-open')) {
      return;
    }

    // If typing in an input, textarea, or select, ignore global shortcuts
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      navigateTo('clients');
      setTimeout(() => {
        const searchInput = document.getElementById('client-search-input');
        if (searchInput) searchInput.focus();
      }, 50);
    } else if (e.key === '1') {
      navigateTo('dashboard');
    } else if (e.key === '2') {
      navigateTo('topology');
    } else if (e.key === '3') {
      navigateTo('clients');
    } else if (e.key === '4') {
      navigateTo('wifi');
    } else if (e.key === '5') {
      navigateTo('backups');
    } else if (e.key === '6') {
      navigateTo('hosts');
    } else if (e.key === '7') {
      navigateTo('settings');
    } else if (e.key === '?') {
      e.preventDefault();
      openShortcutsHelp();
    } else if (e.key.toLowerCase() === 'r') {
      store.poll();
      toast.info('Refreshing', 'Polling OpenWrt routers...');
    }
  });
}

function openShortcutsHelp() {
  const dialog = document.getElementById('shortcuts-help-dialog');
  const triggerBtn = document.getElementById('open-shortcuts-help-btn');
  if (dialog) {
    openModal(dialog, triggerBtn);
  }
}

const notifiedCompletedJobIds = new Set();

function updateGlobalUpgradeBanner() {
  const banner = document.getElementById('global-upgrade-tracker');
  if (!banner) return;

  const dismissed = store.state.dismissedJobIds || new Set();
  const allJobs = Array.isArray(store.state.upgradeJobs) ? store.state.upgradeJobs : [];

  // Toast once when a background job completes or fails
  for (const j of allJobs) {
    if (j.status !== 'running' && !notifiedCompletedJobIds.has(j.id)) {
      notifiedCompletedJobIds.add(j.id);
      if (j.status === 'completed') {
        toast.success(
          `Upgrade Completed (${j.hostName})`,
          j.phase || 'Background software upgrade finished successfully.'
        );
      } else if (j.status === 'failed') {
        toast.error(
          `Upgrade Failed (${j.hostName})`,
          j.error || j.phase || 'Background software upgrade encountered an error.'
        );
      }
    }
  }

  // Show running jobs, or recently finished jobs (within last 60 seconds) that haven't been dismissed
  const nowMs = Date.now();
  const visibleJobs = allJobs.filter((j) => {
    if (dismissed.has(j.id)) return false;
    if (j.status === 'running') return true;
    if (j.completedAt && nowMs - new Date(j.completedAt).getTime() < 60000) return true;
    return false;
  });

  if (visibleJobs.length === 0) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  const job = visibleJobs.find((j) => j.status === 'running') || visibleJobs[0];
  const isRunning = job.status === 'running';
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';
  const pct = Math.max(0, Math.min(100, Math.round(job.progressPct || (isCompleted ? 100 : 5))));
  const progressClass = isCompleted ? 'success' : isFailed ? 'warning' : '';

  banner.style.display = 'flex';
  banner.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;">
      <div style="display: flex; align-items: center; gap: 10px;">
        ${isRunning
          ? `<progress class="loading-spinner" aria-label="Upgrading software on ${escapeHtml(job.hostName)}"></progress>`
          : isCompleted
            ? `<span class="status-pill success" style="padding: 2px 8px;">✓ Done</span>`
            : `<span class="status-pill danger" style="padding: 2px 8px;">✕ Error</span>`}
        <div>
          <span style="font-weight: 700; color: var(--color-text-primary);">
            ${escapeHtml(job.hostName)}:
          </span>
          <span style="color: var(--color-text-secondary); margin-left: 4px;">
            ${escapeHtml(job.phase || 'Running software upgrade in background...')}
          </span>
          ${job.currentPackage
            ? `<span class="font-mono" style="margin-left: 6px; font-size: 11.5px; color: var(--color-primary); font-weight: 600;">[${escapeHtml(job.currentPackage)}]</span>`
            : ''}
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 12px; flex: 1; max-width: 440px; min-width: 240px; justify-content: flex-end;">
        <div style="flex: 1; min-width: 110px;">
          <progress class="custom-progress ${progressClass}" max="100" value="${pct}" aria-label="Software upgrade progress ${pct}%"></progress>
        </div>
        <span class="font-mono" style="font-size: 12px; font-weight: 700; min-width: 42px; text-align: right; color: ${isCompleted ? 'var(--color-success)' : isFailed ? 'var(--color-danger)' : 'var(--color-primary)'};">
          ${pct}%
        </span>
        <button type="button" class="btn btn-secondary" id="banner-view-upgrade-btn" data-host-id="${escapeHtml(job.hostId)}" style="height: 26px; padding: 0 10px; font-size: 11.5px;">
          View Live Progress
        </button>
        ${!isRunning
          ? `<button type="button" class="btn-icon" id="banner-dismiss-upgrade-btn" data-job-id="${escapeHtml(job.id)}" style="width: 24px; height: 24px;" aria-label="Dismiss upgrade banner" title="Dismiss">
              ${renderIcon('x', 'icon icon-sm')}
            </button>`
          : ''}
      </div>
    </div>
  `;

  banner.querySelector('#banner-view-upgrade-btn')?.addEventListener('click', () => {
    const targetHostId = job.hostId;
    if (getActiveRoute() !== 'hosts') {
      navigateTo('hosts');
      setTimeout(() => {
        openHostUpdatesModal(document.getElementById('main-content'), targetHostId);
      }, 60);
    } else {
      openHostUpdatesModal(document.getElementById('main-content'), targetHostId);
    }
  });

  banner.querySelector('#banner-dismiss-upgrade-btn')?.addEventListener('click', () => {
    store.dismissUpgradeJob(job.id);
  });
}

function initApp() {
  initDrawer();
  setupKeyboardShortcuts();

  // Router listener
  window.addEventListener('hashchange', dispatchView);

  // Store listeners
  store.on('upgrade-progress', () => {
    updateGlobalUpgradeBanner();
  });

  store.on('data-refreshed', (state) => {
    updateTopBarAndFooter(state);
    updateGlobalUpgradeBanner();
    const activeRoute = getActiveRoute();
    if (activeRoute === 'topology') {
      updateTopologyData();
    } else if (activeRoute === 'clients') {
      updateClientsData();
    } else if (!document.querySelector('dialog[open]')) {
      dispatchView();
    }
  });

  store.on('connection-error', (err) => {
    const banner = document.getElementById('connection-error-banner');
    if (banner) {
      banner.style.display = 'flex';
      const msg = banner.querySelector('.banner-msg');
      if (msg) msg.textContent = `Lost connection to OpenWrt backend (${err.message}). Retrying automatically...`;
    }
  });

  store.on('fetch-start', () => {
    const btn = document.getElementById('topbar-refresh-btn');
    if (btn) btn.classList.add('spinning');
  });

  store.on('fetch-end', () => {
    const btn = document.getElementById('topbar-refresh-btn');
    if (btn) btn.classList.remove('spinning');
    const banner = document.getElementById('connection-error-banner');
    if (banner && !store.state.connectionLost) {
      banner.style.display = 'none';
    }
  });

  // Topbar Actions
  document.getElementById('topbar-refresh-btn')?.addEventListener('click', () => {
    store.poll();
    toast.info('Updating', 'Querying fleet telemetry...');
  });

  document.getElementById('topbar-backup-all-btn')?.addEventListener('click', async () => {
    try {
      toast.info('Backup Queued', 'Running concurrent snapshot across all routers...');
      await api.runBackup('all');
      toast.success('Backup Finished', 'Archives safely saved to TrueNAS /backups.');
      store.poll();
    } catch (err) {
      toast.error('Backup Error', err.message);
    }
  });

  // Mobile Drawer Navigation (P0-1)
  const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
  const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  const closeMobileMenu = () => {
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (sidebarBackdrop) sidebarBackdrop.style.display = 'none';
    if (mobileMenuToggle) mobileMenuToggle.setAttribute('aria-expanded', 'false');
  };

  const toggleMobileMenu = () => {
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('mobile-open');
    if (sidebarBackdrop) sidebarBackdrop.style.display = isOpen ? 'block' : 'none';
    if (mobileMenuToggle) mobileMenuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  };

  mobileMenuToggle?.addEventListener('click', toggleMobileMenu);
  sidebarBackdrop?.addEventListener('click', closeMobileMenu);

  sidebar?.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', closeMobileMenu);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar?.classList.contains('mobile-open')) {
      closeMobileMenu();
    }
  });

  // Topbar Demo Mode Switcher (P1-2)
  const modePill = document.getElementById('topbar-mode-pill');
  const toggleDemoMode = async () => {
    const isDemo = Boolean(store.state.health?.demoMode);
    const confirmed = await confirmAction({
      title: isDemo ? 'Switch to TrueNAS Live Mode?' : 'Switch to Demo Mode?',
      message: isDemo
        ? 'Switching to Live Mode will query your real configured OpenWrt routers. Simulated nodes and traffic will be replaced.'
        : 'Switching to Demo Mode will load a realistic 3-node simulated topology with 24 clients for demonstration and offline testing.',
      confirmLabel: isDemo ? 'Switch to Live Mode' : 'Load Demo Environment',
      isDestructive: false
    });
    if (confirmed) {
      try {
        await api.configureSimulator({ enabled: !isDemo });
        toast.success('Mode Switched', `Active environment: ${!isDemo ? 'Demo Mode' : 'TrueNAS Live Mode'}`);
        await store.poll(true);
      } catch (err) {
        toast.error('Mode Switch Failed', err.message);
      }
    }
  };
  modePill?.addEventListener('click', toggleDemoMode);
  modePill?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleDemoMode();
    }
  });

  // Shortcuts Help Dialog (P2-2)
  document.getElementById('open-shortcuts-help-btn')?.addEventListener('click', openShortcutsHelp);
  document.getElementById('shortcuts-help-close-btn')?.addEventListener('click', () => closeModal('shortcuts-help-dialog'));
  document.getElementById('shortcuts-help-ok-btn')?.addEventListener('click', () => closeModal('shortcuts-help-dialog'));

  // Initial Route Dispatch and start background polling
  dispatchView();
  store.startPolling(10000);
}

// Boot on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
