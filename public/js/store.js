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
    this.pollIntervalMs = 10000;
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
  }

  async poll() {
    if (this.state.isFetching) return;
    this.state.isFetching = true;
    this.emit('fetch-start');

    try {
      const [health, hosts, topology, clients, wifiChannels, wifiInterference, backups] = await Promise.all([
        api.getHealth().catch(() => null),
        api.getHosts().catch(() => []),
        api.getTopology().catch(() => ({ nodes: [], links: [] })),
        api.getClients().catch(() => []),
        api.getWifiChannels().catch(() => ({ bands: {} })),
        api.getWifiInterference().catch(() => ({ summary: { healthScore: 100 }, warnings: [] })),
        api.getBackups().catch(() => [])
      ]);

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

      // Keep max 30 points of throughput history
      const now = new Date();
      const history = [...this.state.throughputHistory, { timestamp: now, rxBps: wanRxBps, txBps: wanTxBps }];
      if (history.length > 30) history.shift();

      this.setState({
        health,
        hosts,
        topology,
        clients,
        wifiChannels,
        wifiInterference,
        backups,
        throughputHistory: history,
        lastPollTime: now,
        connectionLost: false,
        connectionError: null,
        isFetching: false
      });

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
