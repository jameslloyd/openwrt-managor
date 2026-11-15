/**
 * OpenWrt Manager (openwrt-managor)
 * Network Topology Map View
 */

import { store } from '../store.js';
import { TopologyGraph } from '../charts/topology-graph.js';
import { SwitchPortDiagram } from '../charts/switch-port-diagram.js';
import { renderIcon } from '../utils/icons.js';

let graphInstance = null;
let switchDiagramInstance = null;
let activeDiagramTab = 'both'; // 'both' | 'network' | 'switch'

export function renderTopology(container) {
  container.innerHTML = `
    <div class="view-header" style="flex-wrap: wrap; gap: 12px;">
      <div class="view-title-group">
        <h1>Network Topology &amp; Switch Port Wiring</h1>
        <p>Interactive multi-tier topology map and physical NIC / switch port patch-panel diagram across all OpenWrt hosts</p>
      </div>
      <div class="view-actions" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <div class="filter-chips" role="group" aria-label="Topology diagram mode" style="margin: 0;">
          <button type="button" class="chip-btn topo-mode-btn ${activeDiagramTab === 'both' ? 'active' : ''}" data-mode="both">Both Diagrams</button>
          <button type="button" class="chip-btn topo-mode-btn ${activeDiagramTab === 'network' ? 'active' : ''}" data-mode="network">Network Map</button>
          <button type="button" class="chip-btn topo-mode-btn ${activeDiagramTab === 'switch' ? 'active' : ''}" data-mode="switch">NIC &amp; Switch Port Diagram</button>
        </div>
        <span class="status-pill online">
          <span class="status-dot online"></span>
          Live Traffic Flow Active
        </span>
      </div>
    </div>

    <div id="topo-graph-mount" style="${activeDiagramTab === 'switch' ? 'display: none;' : ''}"></div>
    <div id="switch-port-diagram-mount" style="${activeDiagramTab === 'network' ? 'display: none;' : ''}"></div>
  `;

  const mount = container.querySelector('#topo-graph-mount');
  const switchMount = container.querySelector('#switch-port-diagram-mount');

  container.querySelectorAll('.topo-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDiagramTab = btn.getAttribute('data-mode') || 'both';
      container.querySelectorAll('.topo-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (mount) mount.style.display = activeDiagramTab === 'switch' ? 'none' : '';
      if (switchMount) switchMount.style.display = activeDiagramTab === 'network' ? 'none' : '';
      updateTopologyData();
    });
  });

  graphInstance = new TopologyGraph({
    container: mount,
    onNodeClick: (item) => {
      if (item.type) {
        store.selectNode(item);
      } else if (item.mac) {
        store.selectClient(item);
      }
    }
  });

  switchDiagramInstance = new SwitchPortDiagram({
    container: switchMount,
    onHostClick: (host) => {
      store.selectNode({
        id: host.id,
        label: host.name || host.hostname || host.label || host.id,
        type: host.role || host.type || 'ap',
        ip: host.ip,
        mac: host.mac,
        model: host.model,
        firmware: host.firmware,
        updates: host.updates,
        nicInfo: host.nicInfo || null,
        switchPorts: host.switchPorts || [],
        status: host.status || 'online',
        metrics: {
          cpuUsagePct: host.cpuUsagePct ?? host.metrics?.cpuUsagePct ?? 0,
          memUsagePct: host.memUsagePct ?? host.metrics?.memUsagePct ?? 0,
          uptimeSec: host.uptimeSec ?? host.metrics?.uptimeSec ?? 0,
          rxRateBps: host.rxRateBps ?? host.metrics?.rxRateBps ?? 0,
          txRateBps: host.txRateBps ?? host.metrics?.txRateBps ?? 0,
          clientCount: host.clientCount ?? host.metrics?.clientCount ?? 0,
        },
      });
    },
    onClientClick: (client) => {
      if (client) store.selectClient(client);
    },
  });

  updateTopologyData();
}

export function updateTopologyData() {
  const { topology, clients, hosts } = store.state;
  if (graphInstance) {
    graphInstance.setData({
      nodes: topology?.nodes || [],
      links: topology?.links || [],
      clients: clients || []
    });
  }
  if (switchDiagramInstance) {
    const topoHostNodes = (topology?.nodes || [])
      .filter((n) => n.type && n.type !== 'wan' && !String(n.type).startsWith('client_'))
      .map((n) => ({
        id: n.id,
        name: n.label || n.id,
        role: n.type,
        ip: n.ip,
        mac: n.mac,
        model: n.model,
        status: n.status,
        nicInfo: n.nicInfo || null,
        switchPorts: n.switchPorts || [],
        metrics: n.metrics || {},
      }));
    const resolvedHosts = Array.isArray(hosts) && hosts.length > 0 ? hosts : topoHostNodes;
    switchDiagramInstance.setData({
      hosts: resolvedHosts,
      clients: clients || [],
      links: topology?.links || [],
    });
  }
}
