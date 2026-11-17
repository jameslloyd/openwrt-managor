import { hostManager } from './hostManager.js';

export class TopologyEngine {
  async getTopology() {
    const dbHosts = await hostManager.getAllHosts();
    if (!dbHosts || dbHosts.length === 0) {
      return { nodes: [], links: [] };
    }

    const liveClients = hostManager.getLiveClients();
    const gwHost = dbHosts.find((h) => h.role === 'gateway') || dbHosts[0];

    const unmanagedSwitchByHostPort = new Map();
    const unmanagedSwitchNodes = [];
    const unmanagedSwitchLinks = [];
    for (const h of dbHosts) {
      const ports = Array.isArray(h.switchPorts) ? h.switchPorts : [];
      for (const p of ports) {
        if (!p.hasUnmanagedSwitch || !p.unmanagedSwitch) continue;
        const usw = p.unmanagedSwitch;
        unmanagedSwitchByHostPort.set(`${h.id}:${p.iface}`, usw);
        if (p.switchPort) {
          unmanagedSwitchByHostPort.set(`${h.id}:${p.switchPort}`, usw);
        }
        unmanagedSwitchNodes.push({
          id: usw.id,
          label: usw.name,
          type: 'unmanaged_switch',
          model: `Unmanaged Switch (${usw.deviceCount} hosts on ${usw.parentPort})`,
          ip: `${usw.parentHostName} • ${usw.parentPort}`,
          status: h.status || 'online',
          parentHostId: usw.parentHostId,
          parentHostName: usw.parentHostName,
          parentIface: usw.parentIface,
          parentPort: usw.parentPort,
          parentPortLabel: usw.parentPortLabel,
          unmanagedSwitch: usw,
          metrics: {
            cpuUsagePct: 0,
            memUsagePct: 0,
            uptimeSec: h.uptimeSec ?? 0,
            rxRateBps: p.rxRateBps ?? 0,
            txRateBps: p.txRateBps ?? 0,
            speedMbps: usw.speedMbps || 1000,
            clientCount: usw.deviceCount || 0,
          },
        });
        unmanagedSwitchLinks.push({
          id: `link-${h.id}-${usw.id}`,
          source: h.id,
          target: usw.id,
          medium: 'ethernet',
          speedMbps: usw.speedMbps || 1000,
          sourcePort: usw.parentPort || p.switchPort || p.iface,
          sourceIface: usw.parentIface || p.iface,
          targetPort: 'Uplink',
          currentRxBps: p.rxRateBps || 0,
          currentTxBps: p.txRateBps || 0,
          status: h.status || 'online',
        });
      }
    }

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
        unmanagedSwitches: Array.isArray(h.unmanagedSwitches) ? h.unmanagedSwitches : [],
        metrics: {
          cpuUsagePct: h.cpuUsagePct ?? 0,
          memUsagePct: h.memUsagePct ?? 0,
          uptimeSec: h.uptimeSec ?? 0,
          rxRateBps: h.rxRateBps ?? 0,
          txRateBps: h.txRateBps ?? 0,
          clientCount: h.clientCount ?? 0,
        },
      })),
      ...unmanagedSwitchNodes,
      ...liveClients.map((c) => {
        const rawHostId = c.connectedTo ? c.connectedTo.hostId : gwHost.id;
        const matchedUsw =
          c.connectionType === 'wired' && c.connectedTo
            ? unmanagedSwitchByHostPort.get(`${rawHostId}:${c.connectedTo.iface}`) ||
              unmanagedSwitchByHostPort.get(`${rawHostId}:${c.connectedTo.switchPort}`) ||
              null
            : null;
        return {
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
          hostId: matchedUsw ? matchedUsw.id : rawHostId,
          unmanagedSwitchId: matchedUsw ? matchedUsw.id : null,
          connectedTo: c.connectedTo || null,
          switchPort: c.connectedTo?.switchPort || null,
          metrics: {
            rxRateBps: c.rxRateBps || 0,
            txRateBps: c.txRateBps || 0,
            signalDbm: c.signalDbm,
            snrDb: c.snrDb,
          },
        };
      }),
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
      ...unmanagedSwitchLinks,
    ];

    const gwFdb = hostManager.fdbByHost.get(gwHost.id) || {};
    for (const h of dbHosts) {
      if (h.id !== gwHost.id) {
        const nic = h.nicInfo || {};
        const parentHostId = nic.upstreamHostId || gwHost.id;
        const parentFdb = hostManager.fdbByHost.get(parentHostId) || gwFdb;
        const uplinkFdb = h.mac ? parentFdb[String(h.mac).toLowerCase()] : null;
        const upIface = nic.upstreamIface || uplinkFdb?.iface || null;
        const upPort = nic.upstreamPort || uplinkFdb?.switchPort || null;
        const matchedUsw =
          (upIface && unmanagedSwitchByHostPort.get(`${parentHostId}:${upIface}`)) ||
          (upPort && unmanagedSwitchByHostPort.get(`${parentHostId}:${upPort}`)) ||
          null;
        const linkSource = matchedUsw ? matchedUsw.id : parentHostId;
        links.push({
          id: `link-${linkSource}-${h.id}`,
          source: linkSource,
          target: h.id,
          medium: h.role === 'mesh' ? 'wifi_mesh' : 'ethernet',
          speedMbps: nic.upstreamSpeedMbps || uplinkFdb?.speedMbps || nic.localSpeedMbps || 1000,
          sourcePort: matchedUsw ? 'Dumb SW' : upPort,
          sourceIface: upIface,
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
      const rawParentId = c.connectedTo?.hostId || gwHost.id;
      const matchedUsw =
        c.connectionType === 'wired' && c.connectedTo
          ? unmanagedSwitchByHostPort.get(`${rawParentId}:${c.connectedTo.iface}`) ||
            unmanagedSwitchByHostPort.get(`${rawParentId}:${c.connectedTo.switchPort}`) ||
            null
          : null;
      const parentId = matchedUsw ? matchedUsw.id : rawParentId;
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
