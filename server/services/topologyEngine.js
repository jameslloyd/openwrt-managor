import { hostManager } from './hostManager.js';

export class TopologyEngine {
  async getTopology() {
    const dbHosts = await hostManager.getAllHosts();
    if (!dbHosts || dbHosts.length === 0) {
      return { nodes: [], links: [] };
    }

    const liveClients = hostManager.getLiveClients();
    const gwHost = dbHosts.find((h) => h.role === 'gateway') || dbHosts[0];

    const nodes = [
      {
        id: 'wan-internet',
        label: 'WAN Uplink',
        type: 'wan',
        ip: gwHost?.wan?.ip || gwHost?.ip || 'WAN',
        status: gwHost?.status === 'online' ? 'online' : 'offline',
        metrics: {
          rxRateBps: gwHost?.rxRateBps || 0,
          txRateBps: gwHost?.txRateBps || 0,
          speedMbps: gwHost?.wan?.speedMbps || 1000,
        },
      },
      ...dbHosts.map((h) => ({
        id: h.id,
        label: h.name || h.hostname,
        type: h.role || 'ap',
        ip: h.ip,
        mac: h.mac || null,
        model: h.model,
        status: h.status || 'online',
        nicInfo: h.nicInfo || null,
        switchPorts: Array.isArray(h.switchPorts) ? h.switchPorts : [],
        metrics: {
          cpuUsagePct: h.cpuUsagePct ?? 0,
          memUsagePct: h.memUsagePct ?? 0,
          uptimeSec: h.uptimeSec ?? 0,
          rxRateBps: h.rxRateBps ?? 0,
          txRateBps: h.txRateBps ?? 0,
          clientCount: h.clientCount ?? 0,
        },
      })),
      ...liveClients.map((c) => ({
        id: `client-${c.mac.replace(/:/g, '')}`,
        label: c.hostname,
        type:
          c.connectionType === 'wired'
            ? 'client_wired'
            : c.connectionType === 'wifi_2g'
              ? 'client_wifi_2g'
              : c.connectionType === 'wifi_5g'
                ? 'client_wifi_5g'
                : 'client_wifi_6g',
        ip: c.ip,
        mac: c.mac,
        status: 'online',
        vendor: c.vendor,
        hostId: c.connectedTo ? c.connectedTo.hostId : gwHost.id,
        connectedTo: c.connectedTo || null,
        switchPort: c.connectedTo?.switchPort || null,
        metrics: {
          rxRateBps: c.rxRateBps || 0,
          txRateBps: c.txRateBps || 0,
          signalDbm: c.signalDbm,
          snrDb: c.snrDb,
        },
      })),
    ];

    const links = [
      {
        id: `link-wan-${gwHost.id}`,
        source: 'wan-internet',
        target: gwHost.id,
        medium: 'ethernet',
        speedMbps: gwHost?.wan?.speedMbps || gwHost?.nicInfo?.wanSpeedMbps || 1000,
        sourcePort: 'ISP',
        targetPort: gwHost?.nicInfo?.wanPort || 'WAN',
        targetIface: gwHost?.nicInfo?.wanIface || 'eth0',
        currentRxBps: gwHost?.rxRateBps || 0,
        currentTxBps: gwHost?.txRateBps || 0,
        status: gwHost.status || 'online',
      },
    ];

    const gwFdb = hostManager.fdbByHost.get(gwHost.id) || {};
    for (const h of dbHosts) {
      if (h.id !== gwHost.id) {
        const nic = h.nicInfo || {};
        const parentHostId = nic.upstreamHostId || gwHost.id;
        const parentFdb = hostManager.fdbByHost.get(parentHostId) || gwFdb;
        const uplinkFdb = h.mac ? parentFdb[String(h.mac).toLowerCase()] : null;
        links.push({
          id: `link-${parentHostId}-${h.id}`,
          source: parentHostId,
          target: h.id,
          medium: h.role === 'mesh' ? 'wifi_mesh' : 'ethernet',
          speedMbps: nic.upstreamSpeedMbps || uplinkFdb?.speedMbps || nic.localSpeedMbps || 1000,
          sourcePort: nic.upstreamPort || uplinkFdb?.switchPort || null,
          sourceIface: nic.upstreamIface || uplinkFdb?.iface || null,
          targetPort: nic.localPort || null,
          targetIface: nic.localIface || null,
          currentRxBps: h.rxRateBps || 0,
          currentTxBps: h.txRateBps || 0,
          status: h.status || 'online',
          vlans: [uplinkFdb?.vlan || 1],
        });
      }
    }

    for (const c of liveClients) {
      const parentId = c.connectedTo?.hostId || gwHost.id;
      links.push({
        id: `link-${parentId}-${c.mac.replace(/:/g, '')}`,
        source: parentId,
        target: `client-${c.mac.replace(/:/g, '')}`,
        medium: c.connectionType === 'wired' ? 'ethernet' : 'wifi_station',
        speedMbps: c.speedMbps || c.rxRateMbps || 100,
        switchPort: c.connectedTo?.switchPort || null,
        iface: c.connectedTo?.iface || null,
        currentRxBps: c.rxRateBps || 0,
        currentTxBps: c.txRateBps || 0,
        signalDbm: c.signalDbm,
        vlans: [c.vlan || 1],
        status: 'online',
      });
    }

    return { nodes, links };
  }
}

export const topologyEngine = new TopologyEngine();
