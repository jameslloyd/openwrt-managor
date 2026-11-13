import { simulator } from './simulator.js';
import { hostManager } from './hostManager.js';

export class TopologyEngine {
  async getTopology() {
    const baseTopo = simulator.getTopology();
    const dbHosts = await hostManager.getAllHosts();

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
