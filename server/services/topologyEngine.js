import { simulator } from './simulator.js';
import { hostManager } from './hostManager.js';

export class TopologyEngine {
  async getTopology() {
    const dbHosts = await hostManager.getAllHosts();
    if (!dbHosts || dbHosts.length === 0) {
      return { nodes: [], links: [] };
    }

    const activeSimHostIds = new Set(dbHosts.filter((h) => h.isSimulated).map((h) => h.id));

    // When no simulated hosts are active (i.e., real hosts mode), build topology strictly from real hosts
    if (activeSimHostIds.size === 0) {
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

    const baseTopo = simulator.getTopology();

    // Check if there are user-added hosts not present in simulator
    const simHostIds = new Set(simulator.getHosts().map((h) => h.id));
    for (const h of dbHosts) {
      if (!simHostIds.has(h.id)) {
        baseTopo.nodes.push({
          id: h.id,
          label: h.name,
          type: h.role || 'ap',
          ip: h.ip,
          mac: h.mac || '00:00:00:00:00:00',
          model: h.model,
          status: h.status,
          metrics: {
            cpuUsagePct: h.cpuUsagePct || 10,
            memUsagePct: h.memUsagePct || 30,
            uptimeSec: h.uptimeSec || 3600,
            rxRateBps: 2000000,
            txRateBps: 800000,
            clientCount: h.clientCount || 0,
          },
        });

        // Link to gateway
        const gwNode = baseTopo.nodes.find((n) => n.type === 'gateway');
        if (gwNode) {
          baseTopo.links.push({
            id: `link-${gwNode.id}-${h.id}`,
            source: gwNode.id,
            target: h.id,
            medium: 'ethernet',
            speedMbps: 1000,
            currentRxBps: 2000000,
            currentTxBps: 800000,
            status: 'online',
            vlans: [1],
          });
        }
      }
    }

    return baseTopo;
  }
}

export const topologyEngine = new TopologyEngine();
