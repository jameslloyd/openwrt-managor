/**
 * OpenWrt Manager (openwrt-managor)
 * Lightweight Reactive Store & Event Bus
 */

import { api } from './api.js';

class Store {
  constructor() {
    this.state = {
      health: null,
      systemInfo: null,
      settings: null,
      hosts: [],
      topology: { nodes: [], links: [] },
      clients: [],
      wifiChannels: { bands: {} },
      wifiInterference: { summary: { status: 'healthy', warningsCount: 0, healthScore: 100 }, warnings: [] },
      backups: [],
      schedules: [],
      upgradeJobs: [],
      dismissedJobIds: new Set(),
      simulator: null,

      // UI Selection State
      selectedNode: null,
      selectedClient: null,
      activeView: 'dashboard',

      // Connection & Polling State
      lastPollTime: null,
      isPolling: false,
      isFetching: false,
      connectionLost: false,
      connectionError: null,

      // Live metrics history for sparkline
      throughputHistory: []
    };

    this.listeners = new Map();
    this.pollTimer = null;
    this.fastUpgradeTimer = null;
    this.isPollingUpgrade = false;
    this.pollIntervalMs = 10000;
    this.hasLoadedStaticResources = false;
    this.lastStaticFetchTime = 0;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(data, this.state);
        } catch (err) {
          console.error(`Error in store listener for "${event}":`, err);
        }
      }
    }
  }

  setState(partial) {
    Object.assign(this.state, partial);
    this.emit('state-changed', this.state);
  }

  startPolling(intervalMs = 10000) {
    this.pollIntervalMs = intervalMs;
    this.stopPolling();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fastUpgradeTimer) {
      clearInterval(this.fastUpgradeTimer);
      this.fastUpgradeTimer = null;
    }
  }

  syncFastUpgradePolling() {
    const hasRunningJob =
      (Array.isArray(this.state.upgradeJobs) && this.state.upgradeJobs.some((j) => j.status === 'running')) ||
      (Array.isArray(this.state.hosts) && this.state.hosts.some((h) => h.activeUpgradeJob?.status === 'running'));

    if (hasRunningJob && !this.fastUpgradeTimer) {
      this.fastUpgradeTimer = setInterval(() => this.pollUpgradeProgress(), 1500);
    } else if (!hasRunningJob && this.fastUpgradeTimer) {
      clearInterval(this.fastUpgradeTimer);
      this.fastUpgradeTimer = null;
    }
  }

  async pollUpgradeProgress() {
    if (this.isPollingUpgrade) return;
    this.isPollingUpgrade = true;
    try {
      const prevRunningIds = new Set(
        (this.state.upgradeJobs || []).filter((j) => j.status === 'running').map((j) => j.id)
      );

      const [jobsRes, hosts] = await Promise.all([
        api.getUpgradeJobs().catch(() => ({ jobs: this.state.upgradeJobs || [] })),
        api.getHosts().catch(() => this.state.hosts || []),
      ]);
      const upgradeJobs = Array.isArray(jobsRes?.jobs) ? jobsRes.jobs : this.state.upgradeJobs || [];

      this.setState({
        upgradeJobs,
        hosts: Array.isArray(hosts) && hosts.length > 0 ? hosts : this.state.hosts,
      });

      this.emit('upgrade-progress', { upgradeJobs, hosts: this.state.hosts });

      const finishedAny = upgradeJobs.some((j) => prevRunningIds.has(j.id) && j.status !== 'running');
      if (finishedAny) {
        this.emit('data-refreshed', this.state);
      }

      this.syncFastUpgradePolling();
    } finally {
      this.isPollingUpgrade = false;
    }
  }

  dismissUpgradeJob(jobId) {
    if (!jobId) return;
    this.state.dismissedJobIds.add(jobId);
    this.emit('upgrade-progress', { upgradeJobs: this.state.upgradeJobs, hosts: this.state.hosts });
  }

  async forceRefresh(hostId = 'all') {
    return this.poll(true, { hostId });
  }

  async poll(force = false, options = {}) {
    if (this.state.isFetching && !force) return;
    this.state.isFetching = true;
    this.emit('fetch-start');

    try {
      const nowMs = Date.now();
      const shouldFetchStatic =
        Boolean(force) ||
        Boolean(options?.refreshStatic) ||
        !this.hasLoadedStaticResources ||
        this.state.activeView === 'backups' ||
        this.state.activeView === 'settings' ||
        nowMs - this.lastStaticFetchTime > 5 * 60 * 1000;

      let refreshBundle = null;
      if (force && options?.skipDeviceRefresh !== true) {
        refreshBundle = await api.refreshHosts(options.hostId || 'all', true).catch(() => null);
      }

      const [health, hosts, topology, clients, wifiChannels, wifiInterference, backups, schedulesRes, settings, jobsRes] = await Promise.all([
        api.getHealth().catch(() => null),
        Array.isArray(refreshBundle?.hosts) ? Promise.resolve(refreshBundle.hosts) : api.getHosts().catch(() => []),
        refreshBundle?.topology ? Promise.resolve(refreshBundle.topology) : api.getTopology().catch(() => ({ nodes: [], links: [] })),
        Array.isArray(refreshBundle?.clients) ? Promise.resolve(refreshBundle.clients) : api.getClients().catch(() => []),
        refreshBundle?.wifiChannels ? Promise.resolve(refreshBundle.wifiChannels) : api.getWifiChannels().catch(() => ({ bands: {} })),
        refreshBundle?.wifiInterference ? Promise.resolve(refreshBundle.wifiInterference) : api.getWifiInterference().catch(() => ({ summary: { healthScore: 100 }, warnings: [] })),
        shouldFetchStatic ? api.getBackups().catch(() => this.state.backups || []) : Promise.resolve(this.state.backups || []),
        shouldFetchStatic ? api.getBackupSchedules().catch(() => ({ schedules: this.state.schedules || [] })) : Promise.resolve({ schedules: this.state.schedules || [] }),
        shouldFetchStatic ? api.getSettings().catch(() => this.state.settings) : Promise.resolve(this.state.settings),
        api.getUpgradeJobs().catch(() => ({ jobs: [] }))
      ]);

      if (shouldFetchStatic) {
        this.hasLoadedStaticResources = true;
        this.lastStaticFetchTime = nowMs;
      }
      const schedules = Array.isArray(schedulesRes?.schedules)
        ? schedulesRes.schedules
        : Array.isArray(schedulesRes)
          ? schedulesRes
          : this.state.schedules || [];
      const upgradeJobs = Array.isArray(jobsRes?.jobs)
        ? jobsRes.jobs
        : this.state.upgradeJobs || [];

      // Calculate aggregated WAN throughput for the sparkline
      let wanRxBps = 0;
      let wanTxBps = 0;
      if (topology?.links) {
        for (const link of topology.links) {
          if (link.source === 'wan-internet' || link.target === 'wan-internet' || link.id?.includes('wan')) {
            wanRxBps = link.currentRxBps || 0;
            wanTxBps = link.currentTxBps || 0;
            break;
          }
        }
      }

      // Keep max 30 points of throughput history (reset if leaving demo mode)
      const wasDemo = this.state.health?.demoMode ?? true;
      const isNowDemo = health?.demoMode ?? false;
      const baseHistory = (wasDemo && !isNowDemo) ? [] : this.state.throughputHistory;

      const now = new Date();
      const history = [...baseHistory, { timestamp: now, rxBps: wanRxBps, txBps: wanTxBps }];
      if (history.length > 30) history.shift();

      let selectedNode = this.state.selectedNode;
      if (selectedNode && selectedNode.id !== 'wan-internet' && !hosts.some(h => h.id === selectedNode.id)) {
        selectedNode = null;
      }

      let selectedClient = this.state.selectedClient;
      if (selectedClient && !clients.some(c => c.mac === selectedClient.mac)) {
        selectedClient = null;
      }

      this.setState({
        health,
        settings: settings || this.state.settings,
        hosts,
        topology,
        clients,
        wifiChannels,
        wifiInterference,
        backups,
        schedules,
        upgradeJobs,
        selectedNode,
        selectedClient,
        throughputHistory: history,
        lastPollTime: now,
        connectionLost: false,
        connectionError: null,
        isFetching: false
      });

      this.syncFastUpgradePolling();
      this.emit('upgrade-progress', { upgradeJobs, hosts });
      this.emit('data-refreshed', this.state);
    } catch (err) {
      console.warn('Polling error:', err);
      this.setState({
        connectionLost: true,
        connectionError: err.message,
        isFetching: false
      });
      this.emit('connection-error', err);
    } finally {
      this.emit('fetch-end');
    }
  }

  selectNode(node) {
    this.setState({ selectedNode: node, selectedClient: null });
    this.emit('node-selected', node);
  }

  selectClient(client) {
    this.setState({ selectedClient: client, selectedNode: null });
    this.emit('client-selected', client);
  }

  clearSelection() {
    this.setState({ selectedNode: null, selectedClient: null });
    this.emit('selection-cleared');
  }
}

export const store = new Store();
export default store;
