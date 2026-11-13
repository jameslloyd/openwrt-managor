/**
 * OpenWrt Manager (openwrt-managor)
 * Interactive Multi-Tier SVG Network Topology Map
 * Tier 0 (WAN) -> Tier 1 (Gateway) -> Tier 2 (APs/Infrastructure) -> Tier 3 (Clients)
 */

import { renderIcon } from '../utils/icons.js';
import { formatBps, formatMac, escapeHtml } from '../utils/formatters.js';

export class TopologyGraph {
  constructor({ container, onNodeClick = null }) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.onNodeClick = onNodeClick;

    this.nodes = [];
    this.links = [];
    this.clients = [];

    // Viewport transform
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.isPanning = false;
    this.startX = 0;
    this.startY = 0;

    // Filters & Display Options
    this.collapseClients = false;
    this.selectedNodeId = null;
    this.bandFilter = 'all'; // all, 2.4g, 5g, 6g, wired
    this.vlanFilter = 'all'; // all, 1, 10, 20

    this.init();
  }

  init() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="topology-wrapper">
        <div class="topology-toolbar">
          <div class="topology-controls">
            <button type="button" class="btn-icon" id="topo-zoom-in" title="Zoom In (+)">
              ${renderIcon('zoomIn', 'icon')}
            </button>
            <button type="button" class="btn-icon" id="topo-zoom-out" title="Zoom Out (-)">
              ${renderIcon('zoomOut', 'icon')}
            </button>
            <button type="button" class="btn-icon" id="topo-fit" title="Fit to Screen (Space)">
              ${renderIcon('fitScreen', 'icon')}
            </button>
            <button type="button" class="btn-icon" id="topo-reset" title="Reset View">
              ${renderIcon('refresh', 'icon')}
            </button>
          </div>

          <div class="topology-filters">
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer;">
              <input type="checkbox" id="topo-toggle-collapse" style="accent-color: var(--color-primary);" />
              <span>Group Clients</span>
            </label>

            <select id="topo-filter-band" class="form-select" style="padding: 4px 8px; font-size: 12px;">
              <option value="all">All Bands</option>
              <option value="wired">Wired Only</option>
              <option value="2.4g">2.4 GHz</option>
              <option value="5g">5 GHz</option>
              <option value="6g">6 GHz</option>
            </select>
          </div>
        </div>

        <div class="topology-viewport" id="topo-viewport">
          <svg class="topology-svg" id="topo-svg"></svg>
        </div>

        <div class="topology-legend">
          <span style="font-weight: 700; margin-right: 4px;">Link Speeds:</span>
          <div class="legend-item"><div class="legend-line speed-10g"></div> 10G SFP+</div>
          <div class="legend-item"><div class="legend-line speed-2-5g"></div> 2.5G Eth</div>
          <div class="legend-item"><div class="legend-line speed-1g"></div> 1G Eth</div>
          <div class="legend-item"><div class="legend-line speed-100m"></div> 100M Eth</div>
          <div class="legend-item"><div class="legend-line mesh"></div> WiFi Mesh</div>
        </div>
      </div>
    `;

    this.viewport = this.container.querySelector('#topo-viewport');
    this.svg = this.container.querySelector('#topo-svg');

    this.bindEvents();
  }

  bindEvents() {
    // Toolbar controls
    this.container.querySelector('#topo-zoom-in')?.addEventListener('click', () => this.zoomBy(1.2));
    this.container.querySelector('#topo-zoom-out')?.addEventListener('click', () => this.zoomBy(0.8));
    this.container.querySelector('#topo-fit')?.addEventListener('click', () => this.fitToScreen());
    this.container.querySelector('#topo-reset')?.addEventListener('click', () => this.resetView());

    const collapseToggle = this.container.querySelector('#topo-toggle-collapse');
    collapseToggle?.addEventListener('change', (e) => {
      this.collapseClients = e.target.checked;
      this.render();
    });

    const bandSelect = this.container.querySelector('#topo-filter-band');
    bandSelect?.addEventListener('change', (e) => {
      this.bandFilter = e.target.value;
      this.render();
    });

    // Viewport Panning (mouse drag)
    this.viewport.addEventListener('mousedown', (e) => {
      if (e.target.closest('.topo-node')) return; // let node handle click
      this.isPanning = true;
      this.startX = e.clientX - this.panX;
      this.startY = e.clientY - this.panY;
      this.viewport.classList.add('panning');
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isPanning) return;
      this.panX = e.clientX - this.startX;
      this.panY = e.clientY - this.startY;
      this.updateTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        this.viewport.classList.remove('panning');
      }
    });

    // Mouse wheel zoom
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoomBy(factor, e.offsetX, e.offsetY);
    }, { passive: false });

    // Keyboard controls
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.15);
      if (e.key === '-' || e.key === '_') this.zoomBy(0.85);
      if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        this.fitToScreen();
      }
    });
  }

  zoomBy(factor) {
    const newZoom = Math.max(0.3, Math.min(3.0, this.zoom * factor));
    this.zoom = newZoom;
    this.updateTransform();
  }

  fitToScreen() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.updateTransform();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.updateTransform();
  }

  updateTransform() {
    const g = this.svg.querySelector('g.topo-root-group');
    if (g) {
      g.setAttribute('transform', `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`);
    }
  }

  setData({ nodes = [], links = [], clients = [] }) {
    this.nodes = nodes || [];
    this.links = links || [];
    this.clients = clients || [];
    this.render();
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    const allNodeEls = this.svg.querySelectorAll('.topo-node');
    allNodeEls.forEach(el => {
      if (el.getAttribute('data-id') === nodeId) {
        el.classList.add('selected');
      } else {
        el.classList.remove('selected');
      }
    });
  }

  render() {
    if (!this.svg) return;

    // Filter nodes and clients
    let displayClients = this.clients;
    if (this.bandFilter !== 'all') {
      displayClients = displayClients.filter(c => {
        if (this.bandFilter === 'wired') return c.connectionType === 'wired';
        if (this.bandFilter === '2.4g') return c.connectionType === 'wifi_2g';
        if (this.bandFilter === '5g') return c.connectionType === 'wifi_5g';
        if (this.bandFilter === '6g') return c.connectionType === 'wifi_6g';
        return true;
      });
    }

    // Node positioning layout calculation (hierarchical tiered tree)
    const nodePositions = new Map();
    const width = this.viewport.clientWidth || 960;
    const centerX = width / 2;

    // Tier 0: WAN Uplink
    const wanNode = this.nodes.find(n => n.type === 'wan') || { id: 'wan-internet', label: 'WAN Uplink', type: 'wan' };
    nodePositions.set(wanNode.id, { x: centerX, y: 50, node: wanNode });

    // Tier 1: Gateway
    const gwNode = this.nodes.find(n => n.type === 'gateway') || { id: 'node-gw-01', label: 'Main Gateway', type: 'gateway' };
    nodePositions.set(gwNode.id, { x: centerX, y: 160, node: gwNode });

    // Tier 2: Access Points / Mesh Nodes & Switches
    const apNodes = this.nodes.filter(n => n.type === 'ap' || n.type === 'switch');
    const apCount = apNodes.length || 1;
    const apSpacing = Math.min(260, width / (apCount + 1));
    const apStartX = centerX - ((apCount - 1) * apSpacing) / 2;

    apNodes.forEach((ap, idx) => {
      nodePositions.set(ap.id, {
        x: apStartX + idx * apSpacing,
        y: 280,
        node: ap
      });
    });

    // Tier 3: Clients (if not collapsed)
    if (!this.collapseClients) {
      // Group clients by connected host
      const clientsByHost = new Map();
      displayClients.forEach(c => {
        const hostId = c.connectedTo?.hostId || gwNode.id;
        if (!clientsByHost.has(hostId)) clientsByHost.set(hostId, []);
        clientsByHost.get(hostId).push(c);
      });

      // Position clients beneath their parent AP/GW
      clientsByHost.forEach((hostClients, hostId) => {
        const parentPos = nodePositions.get(hostId) || { x: centerX, y: 280 };
        const cCount = hostClients.length;
        const cSpacing = 70;
        const cStart = parentPos.x - ((cCount - 1) * cSpacing) / 2;

        hostClients.forEach((client, cIdx) => {
          nodePositions.set(`client-${client.mac}`, {
            x: cStart + cIdx * cSpacing,
            y: 430 + (cIdx % 2) * 40, // stagger vertically to avoid overlap
            client: client
          });
        });
      });
    }

    // Generate Links SVG
    let linksSvg = '';
    for (const link of this.links) {
      const srcPos = nodePositions.get(link.source);
      const tgtPos = nodePositions.get(link.target);
      if (!srcPos || !tgtPos) continue;

      let speedClass = 'speed-1g';
      if (link.speedMbps >= 10000) speedClass = 'speed-10g';
      else if (link.speedMbps >= 2500) speedClass = 'speed-2-5g';
      else if (link.speedMbps <= 100) speedClass = 'speed-100m';

      let mediumClass = '';
      if (link.medium === 'wifi_mesh') mediumClass = 'wifi-mesh';
      else if (link.medium === 'wifi_station') mediumClass = 'wifi-station';

      // Curved Bezier line
      const midY = (srcPos.y + tgtPos.y) / 2;
      const pathD = `M ${srcPos.x} ${srcPos.y} C ${srcPos.x} ${midY}, ${tgtPos.x} ${midY}, ${tgtPos.x} ${tgtPos.y}`;

      linksSvg += `
        <g class="topo-link-group">
          <path d="${pathD}" class="topo-link ${speedClass} ${mediumClass}" />
          ${link.speedMbps ? `
            <text x="${(srcPos.x + tgtPos.x) / 2}" y="${midY - 4}" class="topo-link-label">
              ${link.speedMbps >= 1000 ? (link.speedMbps / 1000) + 'G' : link.speedMbps + 'M'}
            </text>
          ` : ''}
        </g>
      `;
    }

    // Connect clients with subtle links
    if (!this.collapseClients) {
      displayClients.forEach(c => {
        const cPos = nodePositions.get(`client-${c.mac}`);
        const parentHostId = c.connectedTo?.hostId || gwNode.id;
        const parentPos = nodePositions.get(parentHostId);
        if (cPos && parentPos) {
          const midY = (parentPos.y + cPos.y) / 2;
          const isWired = c.connectionType === 'wired';
          linksSvg += `
            <path d="M ${parentPos.x} ${parentPos.y} C ${parentPos.x} ${midY}, ${cPos.x} ${midY}, ${cPos.x} ${cPos.y}"
                  class="topo-link ${isWired ? 'speed-1g' : 'wifi-station'}" opacity="0.4" />
          `;
        }
      });
    }

    // Generate Nodes SVG
    let nodesSvg = '';
    nodePositions.forEach((pos, id) => {
      if (pos.node) {
        // Core Infra Node (WAN, Gateway, AP, Switch)
        const n = pos.node;
        const isGw = n.type === 'gateway';
        const isWan = n.type === 'wan';
        const isSelected = this.selectedNodeId === n.id;
        const w = 150;
        const h = 58;

        nodesSvg += `
          <g class="topo-node ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(n.id)}" transform="translate(${pos.x - w / 2}, ${pos.y - h / 2})">
            <rect width="${w}" height="${h}" class="topo-node-card" />
            <circle cx="16" cy="20" r="5" fill="${n.status === 'online' ? 'var(--color-success)' : 'var(--color-danger)'}" />
            <text x="30" y="24" class="topo-node-label" text-anchor="start">${escapeHtml(n.label || n.id)}</text>
            <text x="30" y="42" class="topo-node-subtext" text-anchor="start">${escapeHtml(n.ip || (isWan ? 'Public IP' : ''))}</text>
          </g>
        `;

        // If clients are collapsed, show a cluster badge
        if (this.collapseClients && !isWan) {
          const clientCount = displayClients.filter(c => (c.connectedTo?.hostId || gwNode.id) === n.id).length;
          if (clientCount > 0) {
            nodesSvg += `
              <g class="client-cluster-badge-group" data-host-id="${escapeHtml(n.id)}" transform="translate(${pos.x + w / 2 - 20}, ${pos.y + h / 2 - 10})">
                <rect width="40" height="20" rx="10" class="client-cluster-badge" />
                <text x="20" y="10" class="client-cluster-text">+${clientCount}</text>
              </g>
            `;
          }
        }
      } else if (pos.client) {
        // Endpoint Client Device
        const c = pos.client;
        const isWired = c.connectionType === 'wired';
        const r = 18;

        nodesSvg += `
          <g class="topo-node topo-client-node" data-mac="${escapeHtml(c.mac)}" transform="translate(${pos.x}, ${pos.y})">
            <circle r="${r}" fill="var(--color-surface-elevated)" stroke="var(--color-border)" stroke-width="1.5" />
            <circle cx="${r - 5}" cy="${-r + 5}" r="3.5" fill="${isWired ? 'var(--color-band-wired)' : 'var(--color-band-5g)'}" />
            <text y="${r + 14}" class="topo-node-label" font-size="10.5" text-anchor="middle">${escapeHtml(c.displayName || c.nickname || c.hostname || c.ip)}</text>
            <text y="${r + 26}" class="topo-node-subtext" font-size="9" text-anchor="middle">${escapeHtml(c.ip)}</text>
          </g>
        `;
      }
    });

    this.svg.innerHTML = `
      <g class="topo-root-group" transform="translate(${this.panX}, ${this.panY}) scale(${this.zoom})">
        <!-- Links Layer -->
        <g class="topo-links-layer">${linksSvg}</g>
        <!-- Nodes Layer -->
        <g class="topo-nodes-layer">${nodesSvg}</g>
      </g>
    `;

    // Attach click events
    this.svg.querySelectorAll('.topo-node').forEach(nodeEl => {
      nodeEl.addEventListener('click', () => {
        const id = nodeEl.getAttribute('data-id');
        const mac = nodeEl.getAttribute('data-mac');

        if (id) {
          this.selectNode(id);
          const found = this.nodes.find(n => n.id === id);
          if (found && this.onNodeClick) this.onNodeClick(found);
        } else if (mac) {
          const foundClient = this.clients.find(c => c.mac === mac);
          if (foundClient && this.onNodeClick) this.onNodeClick(foundClient);
        }
      });
    });
  }
}
