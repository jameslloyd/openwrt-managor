import { hostManager } from './hostManager.js';

export class TopologyEngine {
  async getTopology() {
    const dbHosts = await hostManager.getAllHosts();
    if (!dbHosts || dbHosts.length === 0) {
      return { nodes: [], links: [] };
    }

    const gwHost = dbHosts.find((h) => h.role === 'gateway') || dbHosts[0];
    const nodes = [
      {
        id: 'wan-internet',
        label: 'WAN Uplink',
        type: 'wan',
        ip: gwHost?.wan?.ip || gwHost?.ip || 'WAN',
        status: gwHost?.status === 'online' ? 'online' : 'offline',
        metrics: {
          rxRateBps: 0,
          txRateBps: 0,
          speedMbps: gwHost?.wan?.speedMbps || 1000,
        },
      },
      ...dbHosts.map((h) => ({
        id: h.id,
        label: h.name || h.hostname,
        type: h.role || 'ap',
        ip: h.ip,
        mac: h.mac || '00:00:00:00:00:00',
        model: h.model,
        status: h.status || 'online',
        metrics: {
          cpuUsagePct: h.cpuUsagePct ?? 10,
          memUsagePct: h.memUsagePct ?? 30,
          uptimeSec: h.uptimeSec ?? 3600,
          rxRateBps: h.rxRateBps ?? 0,
          txRateBps: h.txRateBps ?? 0,
          clientCount: h.clientCount ?? 0,
        },
      })),
    ];

    const links = [
      {
        id: `link-wan-${gwHost.id}`,
        source: 'wan-internet',
        target: gwHost.id,
        medium: 'ethernet',
        speedMbps: gwHost?.wan?.speedMbps || 1000,
        currentRxBps: 0,
        currentTxBps: 0,
        status: gwHost.status || 'online',
      },
    ];

    for (const h of dbHosts) {
      if (h.id !== gwHost.id) {
        links.push({
          id: `link-${gwHost.id}-${h.id}`,
          source: gwHost.id,
          target: h.id,
          medium: h.role === 'mesh' ? 'wifi_mesh' : 'ethernet',
          speedMbps: 1000,
          currentRxBps: 0,
          currentTxBps: 0,
          status: h.status || 'online',
          vlans: [1],
        });
      }
    }

    return { nodes, links };
  }
}

export const topologyEngine = new TopologyEngine();
