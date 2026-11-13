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
import { renderHosts } from './views/hosts.js';
import { renderSettings } from './views/settings.js';
import { toast } from './components/toast.js';
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

  // Top Bar Mode Pill
  const modePill = document.getElementById('topbar-mode-pill');
  if (modePill) {
    modePill.className = 'mode-pill';
    modePill.textContent = 'TrueNAS Live Mode';
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
    } else if (e.key.toLowerCase() === 'r') {
      store.poll();
      toast.info('Refreshing', 'Polling OpenWrt routers...');
    }
  });
}

function initApp() {
  initDrawer();
  setupKeyboardShortcuts();

  // Router listener
  window.addEventListener('hashchange', dispatchView);

  // Store listeners
  store.on('data-refreshed', (state) => {
    updateTopBarAndFooter(state);
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
