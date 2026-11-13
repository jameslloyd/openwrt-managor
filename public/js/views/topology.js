/**
 * OpenWrt Manager (openwrt-managor)
 * Network Topology Map View
 */

import { store } from '../store.js';
import { TopologyGraph } from '../charts/topology-graph.js';
import { renderIcon } from '../utils/icons.js';

let graphInstance = null;

export function renderTopology(container) {
  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>Network Topology Map</h1>
        <p>Interactive multi-tier physical & wireless network layout (WAN → Gateway → APs → Clients)</p>
      </div>
      <div class="view-actions">
        <span class="status-pill online">
          <span class="status-dot online"></span>
          Live Traffic Flow Active
        </span>
      </div>
    </div>

    <div id="topo-graph-mount"></div>
  `;

  const mount = container.querySelector('#topo-graph-mount');
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

  updateTopologyData();
}

export function updateTopologyData() {
  if (!graphInstance) return;
  const { topology, clients } = store.state;
  graphInstance.setData({
    nodes: topology?.nodes || [],
    links: topology?.links || [],
    clients: clients || []
  });
}
