/**
 * OpenWrt Manager (openwrt-managor)
 * Interactive Multi-Tier SVG Network Topology Map
 * Tier 0 (WAN) -> Tier 1 (Gateway) -> Tier 2 (APs/Infrastructure) -> Tier 3 (Clients)
 */

import { renderIcon } from '../utils/icons.js';
import { escapeHtml, formatSwitchPort } from '../utils/formatters.js';

function truncateLabel(str, maxLen = 18) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

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
    this.hasInitialFit = false;
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
            <button type="button" class="btn-icon" id="topo-zoom-in" title="Zoom In (+)" aria-label="Zoom In">
              ${renderIcon('zoomIn', 'icon')}
            </button>
            <button type="button" class="btn-icon" id="topo-zoom-out" title="Zoom Out (-)" aria-label="Zoom Out">
              ${renderIcon('zoomOut', 'icon')}
            </button>
            <button type="button" class="btn-icon" id="topo-fit" title="Fit to Screen (Space)" aria-label="Fit to Screen">
              ${renderIcon('fitScreen', 'icon')}
            </button>
            <button type="button" class="btn-icon" id="topo-reset" title="Reset View" aria-label="Reset View">
              ${renderIcon('refresh', 'icon')}
            </button>
          </div>

          <div class="topology-filters">
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer;">
              <input type="checkbox" id="topo-toggle-collapse" style="accent-color: var(--color-primary);" />
              <span>Group Clients</span>
            </label>

            <label for="topo-filter-band" class="sr-only">Filter by Band</label>
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
          <svg class="topology-svg" id="topo-svg" role="img" aria-label="Interactive Network Topology Map">
            <title>Interactive Network Topology Map</title>
          </svg>
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
    this.container.querySelector('#topo-zoom-in')?.addEventListener('click', () => this.zoomBy(1.2));
    this.container.querySelector('#topo-zoom-out')?.addEventListener('click', () => this.zoomBy(0.8));
    this.container.querySelector('#topo-fit')?.addEventListener('click', () => this.fitToScreen());
    this.container.querySelector('#topo-reset')?.addEventListener('click', () => this.resetView());

    const collapseToggle = this.container.querySelector('#topo-toggle-collapse');
    collapseToggle?.addEventListener('change', (e) => {
      this.collapseClients = e.target.checked;
      this.render();
      this.fitToScreen();
    });

    const bandSelect = this.container.querySelector('#topo-filter-band');
    bandSelect?.addEventListener('change', (e) => {
      this.bandFilter = e.target.value;
      this.render();
      this.fitToScreen();
    });

    // Viewport Panning (mouse drag)
    this.viewport.addEventListener('mousedown', (e) => {
      if (e.target.closest('.topo-node') || e.target.closest('.client-cluster-badge-group')) return;
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
    this.viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        this.zoomBy(factor, e.offsetX, e.offsetY);
      },
      { passive: false }
    );

    // Touch Panning & Pinch Zoom
    let touchStartX = 0;
    let touchStartY = 0;
    let initialPinchDist = null;

    this.viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX - this.panX;
        touchStartY = e.touches[0].clientY - this.panY;
      } else if (e.touches.length === 2) {
        initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    }, { passive: true });

    this.viewport.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && initialPinchDist === null) {
        this.panX = e.touches[0].clientX - touchStartX;
        this.panY = e.touches[0].clientY - touchStartY;
        this.updateTransform();
      } else if (e.touches.length === 2 && initialPinchDist) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = dist / initialPinchDist;
        if (Math.abs(factor - 1) > 0.05) {
          this.zoomBy(factor > 1 ? 1.05 : 0.95);
          initialPinchDist = dist;
        }
      }
    }, { passive: true });

    this.viewport.addEventListener('touchend', () => {
      initialPinchDist = null;
    }, { passive: true });

    // Keyboard Arrow Navigation & Zoom
    this.viewport.setAttribute('tabindex', '0');
    this.viewport.setAttribute('role', 'region');
    this.viewport.setAttribute('aria-label', 'Network Topology Map Canvas. Use arrow keys to pan, plus/minus to zoom.');
    this.viewport.addEventListener('keydown', (e) => {
      const panStep = 40;
      if (e.key === 'ArrowUp') { e.preventDefault(); this.panY += panStep; this.updateTransform(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.panY -= panStep; this.updateTransform(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.panX += panStep; this.updateTransform(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.panX -= panStep; this.updateTransform(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1.15); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(0.85); }
      else if (e.key === '0' || e.key === ' ') { e.preventDefault(); this.fitToScreen(); }
    });
  }

  zoomBy(factor) {
    const newZoom = Math.max(0.3, Math.min(3.0, this.zoom * factor));
    this.zoom = newZoom;
    this.updateTransform();
  }

  fitToScreen() {
    if (!this.bounds || !this.viewport) {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.updateTransform();
      return;
    }

    const vw = this.viewport.clientWidth || 960;
    const vh = this.viewport.clientHeight || 540;
    const bw = Math.max(200, this.bounds.maxX - this.bounds.minX + 120);
    const bh = Math.max(200, this.bounds.maxY - this.bounds.minY + 120);

    const scaleX = vw / bw;
    const scaleY = vh / bh;
    this.zoom = Math.max(0.45, Math.min(1.15, Math.min(scaleX, scaleY)));

    const contentCenterX = (this.bounds.minX + this.bounds.maxX) / 2;
    const contentCenterY = (this.bounds.minY + this.bounds.maxY) / 2;

    this.panX = vw / 2 - contentCenterX * this.zoom;
    this.panY = vh / 2 - contentCenterY * this.zoom;
    this.updateTransform();
  }

  resetView() {
    this.fitToScreen();
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
    if (!this.hasInitialFit && (this.nodes.length > 0 || this.clients.length > 0)) {
      this.hasInitialFit = true;
      this.fitToScreen();
    }
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    const allNodeEls = this.svg.querySelectorAll('.topo-node');
    allNodeEls.forEach((el) => {
      if (el.getAttribute('data-id') === nodeId) {
        el.classList.add('selected');
      } else {
        el.classList.remove('selected');
      }
    });
  }

  render() {
    if (!this.svg) return;

    // Filter clients by band
    let displayClients = this.clients;
    if (this.bandFilter !== 'all') {
      displayClients = displayClients.filter((c) => {
        if (this.bandFilter === 'wired') return c.connectionType === 'wired';
        if (this.bandFilter === '2.4g') return c.connectionType === 'wifi_2g';
        if (this.bandFilter === '5g') return c.connectionType === 'wifi_5g';
        if (this.bandFilter === '6g') return c.connectionType === 'wifi_6g';
        return true;
      });
    }

    const nodePositions = new Map();
    const width = this.viewport.clientWidth || 960;
    const centerX = width / 2;

    const wanNode = this.nodes.find((n) => n.type === 'wan');
    const gwNode = this.nodes.find((n) => n.type === 'gateway');
    const apNodes = this.nodes.filter(
      (n) => n.type === 'ap' || n.type === 'mesh' || n.type === 'switch' || n.type === 'unmanaged_switch'
    );
    const defaultParentId = gwNode?.id || apNodes[0]?.id || 'wan-internet';

    const unmanagedSwitchByHostPort = new Map();
    for (const n of this.nodes) {
      if (n.type === 'unmanaged_switch' && n.parentHostId) {
        if (n.parentIface) unmanagedSwitchByHostPort.set(`${n.parentHostId}:${n.parentIface}`, n);
        if (n.parentPort) unmanagedSwitchByHostPort.set(`${n.parentHostId}:${n.parentPort}`, n);
      }
    }
    const resolveClientParentId = (c) => {
      const rawHostId = c.connectedTo?.hostId || defaultParentId;
      if (c.connectionType === 'wired' && c.connectedTo) {
        const usw =
          unmanagedSwitchByHostPort.get(`${rawHostId}:${c.connectedTo.iface}`) ||
          unmanagedSwitchByHostPort.get(`${rawHostId}:${c.connectedTo.switchPort}`);
        if (usw) return usw.id;
      }
      return rawHostId;
    };

    // Group clients by connected host first so AP horizontal spacing accounts for client fan-out
    const clientsByHost = new Map();
    displayClients.forEach((c) => {
      const hostId = resolveClientParentId(c);
      if (!clientsByHost.has(hostId)) clientsByHost.set(hostId, []);
      clientsByHost.get(hostId).push(c);
    });

    const clientColSpacing = 128; // Wide enough so 16-char hostnames and IP addresses never collide
    const clientRowSpacing = 88; // Tall enough for circle + 2 text rows + link clearance
    const maxColsPerCluster = 4; // Wrap larger client groups into neat multi-row grids under their AP

    // Tier 0: WAN Uplink
    if (wanNode) {
      nodePositions.set(wanNode.id, { x: centerX, y: 55, node: wanNode });
    }

    // Build a multi-tier hierarchy tree for Gateway, Managed Switches, Dumb Switches, and APs
    // sorted by upstream switch port number so links fan out monotonically without crossing
    const infraNodes = [gwNode, ...apNodes].filter(Boolean);
    const infraById = new Map(infraNodes.map((n) => [n.id, n]));
    const childrenByParent = new Map();
    infraNodes.forEach((n) => childrenByParent.set(n.id, []));

    const extractPortOrder = (str) => {
      if (!str) return 999;
      const m = String(str).match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 999;
    };

    const assignedChildIds = new Set();
    if (gwNode) assignedChildIds.add(gwNode.id);

    // Connect each non-gateway infra node to its upstream parent infra node
    apNodes.forEach((node, idx) => {
      const incomingLink = this.links.find(
        (l) => l.target === node.id && l.source !== 'wan-internet' && infraById.has(l.source)
      );
      let parentId =
        incomingLink?.source ||
        node.parentHostId ||
        node.nicInfo?.upstreamHostId ||
        gwNode?.id ||
        null;

      if (!parentId || !infraById.has(parentId) || parentId === node.id) {
        parentId = gwNode?.id || null;
      }

      if (parentId && childrenByParent.has(parentId)) {
        const portStr =
          incomingLink?.sourcePort ||
          incomingLink?.sourceIface ||
          node.parentPort ||
          node.parentIface ||
          node.nicInfo?.upstreamPort ||
          node.nicInfo?.upstreamIface ||
          '';
        childrenByParent.get(parentId).push({
          node,
          portOrder: extractPortOrder(portStr),
          origIdx: idx,
        });
        assignedChildIds.add(node.id);
      }
    });

    // Sort every parent's children by upstream port number so links never cross horizontally
    childrenByParent.forEach((list) => {
      list.sort((a, b) => {
        if (a.portOrder !== b.portOrder) return a.portOrder - b.portOrder;
        return a.origIdx - b.origIdx;
      });
    });

    const getDirectClientClusterWidth = (hostId) => {
      if (this.collapseClients) return 0;
      const count = (clientsByHost.get(hostId) || []).length;
      if (count === 0) return 0;
      const cols = Math.min(maxColsPerCluster, Math.max(1, count));
      return Math.max(240, cols * clientColSpacing + 48);
    };

    const subtreeWidths = new Map();
    const visitedWidth = new Set();
    const computeSubtreeWidth = (nodeId) => {
      if (visitedWidth.has(nodeId)) return 240;
      visitedWidth.add(nodeId);
      const children = childrenByParent.get(nodeId) || [];
      const directClientW = getDirectClientClusterWidth(nodeId);

      if (children.length === 0) {
        const w = Math.max(240, directClientW);
        subtreeWidths.set(nodeId, w);
        return w;
      }

      let totalChildrenW = 0;
      children.forEach(({ node: child }) => {
        totalChildrenW += computeSubtreeWidth(child.id);
      });
      if (directClientW > 0) {
        totalChildrenW += directClientW;
      }
      const w = Math.max(240, totalChildrenW);
      subtreeWidths.set(nodeId, w);
      return w;
    };

    const clientClusterCenters = new Map();
    const tierStepY = 140;
    const visitedLayout = new Set();

    const layoutSubtree = (nodeId, leftX, y) => {
      if (visitedLayout.has(nodeId)) return;
      visitedLayout.add(nodeId);
      const node = infraById.get(nodeId);
      if (!node) return;

      const totalW = subtreeWidths.get(nodeId) || 240;
      const children = childrenByParent.get(nodeId) || [];
      const directClientW = getDirectClientClusterWidth(nodeId);

      if (children.length === 0) {
        const cx = leftX + totalW / 2;
        nodePositions.set(nodeId, { x: cx, y, node });
        if (directClientW > 0) {
          clientClusterCenters.set(nodeId, { x: cx, y: y + 148 });
        }
        return;
      }

      let cursorX = leftX;
      const childCenters = [];
      children.forEach(({ node: child }) => {
        const cw = subtreeWidths.get(child.id) || 240;
        layoutSubtree(child.id, cursorX, y + tierStepY);
        const cPos = nodePositions.get(child.id);
        if (cPos) childCenters.push(cPos.x);
        cursorX += cw;
      });

      if (directClientW > 0) {
        clientClusterCenters.set(nodeId, {
          x: cursorX + directClientW / 2,
          y: y + tierStepY,
        });
        cursorX += directClientW;
      }

      // Center parent above its child infrastructure nodes (or total span if single child)
      const parentX =
        childCenters.length > 0
          ? (childCenters[0] + childCenters[childCenters.length - 1]) / 2
          : leftX + totalW / 2;
      nodePositions.set(nodeId, { x: parentX, y, node });
    };

    if (gwNode) {
      const rootW = computeSubtreeWidth(gwNode.id);
      layoutSubtree(gwNode.id, centerX - rootW / 2, 175);
      // Keep WAN node aligned directly above Gateway
      const gwPos = nodePositions.get(gwNode.id);
      if (wanNode && gwPos) {
        nodePositions.set(wanNode.id, { x: gwPos.x, y: 55, node: wanNode });
      }
    }

    // Lay out any remaining unattached infra nodes if present
    const unplacedInfra = infraNodes.filter((n) => !nodePositions.has(n.id));
    if (unplacedInfra.length > 0) {
      unplacedInfra.forEach((n) => computeSubtreeWidth(n.id));
      const span = unplacedInfra.reduce((acc, n) => acc + (subtreeWidths.get(n.id) || 240), 0);
      let cursorX = centerX - span / 2;
      const baseY = gwNode ? 315 : 195;
      unplacedInfra.forEach((n) => {
        const w = subtreeWidths.get(n.id) || 240;
        layoutSubtree(n.id, cursorX, baseY);
        cursorX += w;
      });
    }

    // Place Clients in non-overlapping multi-row grids beneath their parent AP / Dumb Switch / Switch / Gateway
    if (!this.collapseClients) {
      clientsByHost.forEach((hostClients, hostId) => {
        const parentPos = nodePositions.get(hostId) || { x: centerX, y: 315 };
        const clusterSlot = clientClusterCenters.get(hostId) || {
          x: parentPos.x,
          y: parentPos.y + 148,
        };
        const clusterCenterX = clusterSlot.x;
        const baseTierY = clusterSlot.y;

        const cCount = hostClients.length;
        const cols = Math.min(maxColsPerCluster, Math.max(1, cCount));

        hostClients.forEach((client, cIdx) => {
          const row = Math.floor(cIdx / cols);
          const col = cIdx % cols;
          const itemsInThisRow = Math.min(cols, cCount - row * cols);
          const rowStartX = clusterCenterX - ((itemsInThisRow - 1) * clientColSpacing) / 2;

          nodePositions.set(`client-${client.mac}`, {
            x: rowStartX + col * clientColSpacing,
            y: baseTierY + row * clientRowSpacing,
            client,
          });
        });
      });
    }

    // Track bounding box for fitToScreen
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    nodePositions.forEach((pos) => {
      const halfW = pos.node ? 95 : 65;
      const halfH = pos.node ? 35 : 45;
      if (pos.x - halfW < minX) minX = pos.x - halfW;
      if (pos.x + halfW > maxX) maxX = pos.x + halfW;
      if (pos.y - halfH < minY) minY = pos.y - halfH;
      if (pos.y + halfH > maxY) maxY = pos.y + halfH;
    });
    if (Number.isFinite(minX)) {
      this.bounds = { minX, maxX, minY, maxY };
    }

    const evalCubicBezier = (v0, v1, v2, v3, t) => {
      const u = 1 - t;
      return (
        u * u * u * v0 +
        3 * u * u * t * v1 +
        3 * u * t * t * v2 +
        t * t * t * v3
      );
    };

    // Generate Infrastructure Links SVG (skip client links here; client links are rendered below)
    let linksSvg = '';
    const placedLinkPills = [];
    for (const link of this.links) {
      if (String(link.target || '').startsWith('client-')) continue;
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

      const y1 = tgtPos.y > srcPos.y ? srcPos.y + 26 : srcPos.y;
      const y2 = tgtPos.y > srcPos.y ? tgtPos.y - 26 : tgtPos.y;
      const midY = (y1 + y2) / 2;
      const pathD = `M ${srcPos.x} ${y1} C ${srcPos.x} ${midY}, ${tgtPos.x} ${midY}, ${tgtPos.x} ${y2}`;
      const speedText = link.speedMbps >= 1000 ? `${link.speedMbps / 1000}G` : `${link.speedMbps}M`;
      let pillLabel = speedText;
      if (link.sourcePort && link.targetPort && link.source !== 'wan-internet') {
        pillLabel = `${link.sourcePort} ⟷ ${link.targetPort} • ${speedText}`;
      } else if (link.sourcePort && link.source !== 'wan-internet') {
        pillLabel = `${link.sourcePort} • ${speedText}`;
      } else if (link.targetPort && link.source === 'wan-internet') {
        pillLabel = `${link.targetPort} • ${speedText}`;
      }
      const pillWidth = pillLabel !== speedText ? Math.max(68, pillLabel.length * 6.0) : 36;
      const pillHeight = 16;

      let pillX = (srcPos.x + tgtPos.x) / 2;
      let pillY = midY;
      for (const t of [0.5, 0.34, 0.66, 0.24, 0.76]) {
        const cx = evalCubicBezier(srcPos.x, srcPos.x, tgtPos.x, tgtPos.x, t);
        const cy = evalCubicBezier(y1, midY, midY, y2, t);
        const collides = placedLinkPills.some(
          (p) =>
            Math.abs(cy - p.y) < pillHeight + 3 &&
            Math.abs(cx - p.x) < (pillWidth + p.w) / 2 + 6
        );
        if (!collides) {
          pillX = cx;
          pillY = cy;
          break;
        }
      }
      placedLinkPills.push({ x: pillX, y: pillY, w: pillWidth, h: pillHeight });

      linksSvg += `
        <g class="topo-link-group">
          <path d="${pathD}" class="topo-link ${speedClass} ${mediumClass}" />
          ${
            link.speedMbps
              ? `
            <rect x="${pillX - pillWidth / 2}" y="${pillY - 10}" width="${pillWidth}" height="${pillHeight}" class="topo-link-pill" />
            <text x="${pillX}" y="${pillY + 1}" class="topo-link-label">
              ${escapeHtml(pillLabel)}
            </text>
          `
              : ''
          }
        </g>
      `;
    }

    // Connect clients with subtle Bezier links
    if (!this.collapseClients) {
      displayClients.forEach((c) => {
        const cPos = nodePositions.get(`client-${c.mac}`);
        const parentHostId = resolveClientParentId(c);
        const parentPos = nodePositions.get(parentHostId) || nodePositions.get(c.connectedTo?.hostId || defaultParentId);
        if (cPos && parentPos) {
          const midY = parentPos.y + (cPos.y - parentPos.y) * 0.45;
          const isWired = c.connectionType === 'wired';
          linksSvg += `
            <path d="M ${parentPos.x} ${parentPos.y + 24} C ${parentPos.x} ${midY}, ${cPos.x} ${midY}, ${cPos.x} ${cPos.y - 18}"
                  class="topo-link ${isWired ? 'speed-1g' : 'wifi-station'}" opacity="0.4" />
          `;
        }
      });
    }

    // Generate Nodes SVG
    let nodesSvg = '';
    nodePositions.forEach((pos) => {
      if (pos.node) {
        // Core Infra Node (WAN, Gateway, AP, Switch, Unmanaged Switch)
        const n = pos.node;
        const isWan = n.type === 'wan';
        const isDumbSw = n.type === 'unmanaged_switch';
        const isSelected = this.selectedNodeId === n.id;
        const w = 176;
        const h = 60;
        const nicBadge = !isWan && n.nicInfo?.localIface
          ? ` • ${n.nicInfo.localIface}`
          : '';
        const fullTitle = `${n.label || n.id} (${n.ip || (isWan ? 'Public IP' : '')}${n.nicInfo?.localPortLabel ? ` • NIC: ${n.nicInfo.localPortLabel}` : ''})`;
        const titleText = truncateLabel(n.label || n.id, 19);
        const subText = truncateLabel(`${n.ip || (isWan ? 'Public IP' : '')}${nicBadge}`, 22);

        nodesSvg += `
          <g class="topo-node ${isSelected ? 'selected' : ''}"
             data-id="${escapeHtml(n.id)}"
             role="button"
             tabindex="0"
             aria-label="${escapeHtml(fullTitle)}"
             transform="translate(${pos.x - w / 2}, ${pos.y - h / 2})">
            <title>${escapeHtml(fullTitle)}</title>
            <rect width="${w}" height="${h}" class="topo-node-card" ${isDumbSw ? 'style="stroke: var(--color-warning); stroke-dasharray: 5,3;"' : ''} />
            <circle cx="16" cy="22" r="5" fill="${isDumbSw ? 'var(--color-warning)' : n.status === 'online' ? 'var(--color-success)' : 'var(--color-danger)'}" />
            <text x="28" y="25" class="topo-node-label" text-anchor="start">${escapeHtml(titleText)}</text>
            <text x="28" y="44" class="topo-node-subtext" text-anchor="start">${escapeHtml(subText)}</text>
          </g>
        `;

        // If clients are collapsed, show a cluster badge
        if (this.collapseClients && !isWan) {
          const clientCount = displayClients.filter((c) => resolveClientParentId(c) === n.id).length;
          if (clientCount > 0) {
            nodesSvg += `
              <g class="client-cluster-badge-group" data-host-id="${escapeHtml(n.id)}" transform="translate(${pos.x + w / 2 - 22}, ${pos.y + h / 2 - 10})">
                <rect width="42" height="20" rx="10" class="client-cluster-badge" />
                <text x="21" y="10" class="client-cluster-text">+${clientCount}</text>
              </g>
            `;
          }
        }
      } else if (pos.client) {
        // Endpoint Client Device
        const c = pos.client;
        const isWired = c.connectionType === 'wired';
        const r = 18;
        const rawName = c.displayName || c.nickname || c.hostname || c.ip || c.mac;
        const shortName = truncateLabel(rawName, 16);
        const ipText = c.ip && c.ip !== '0.0.0.0' ? c.ip : c.mac;
        const port = isWired ? formatSwitchPort(c.connectedTo, c.rxRateMbps) : null;
        const clientSubLabel = isWired && port?.portBadge
          ? `${port.portBadge} • ${ipText}`
          : ipText;
        const fullClientDesc = isWired && port?.portBadge
          ? `${rawName} (${port.portBadge} • ${ipText})`
          : `${rawName} (${ipText})`;

        nodesSvg += `
          <g class="topo-node topo-client-node"
             data-mac="${escapeHtml(c.mac)}"
             role="button"
             tabindex="0"
             aria-label="${escapeHtml(fullClientDesc)}"
             transform="translate(${pos.x}, ${pos.y})">
            <title>${escapeHtml(fullClientDesc)}</title>
            <circle r="${r}" fill="var(--color-surface-elevated)" stroke="var(--color-border)" stroke-width="1.5" />
            <circle cx="${r - 5}" cy="${-r + 5}" r="3.5" fill="${isWired ? 'var(--color-band-wired)' : 'var(--color-band-5g)'}" />
            <text x="0" y="${r + 15}" class="topo-node-label" font-size="11" text-anchor="middle">${escapeHtml(shortName)}</text>
            <text x="0" y="${r + 29}" class="topo-node-subtext" font-size="9.5" text-anchor="middle">${escapeHtml(truncateLabel(clientSubLabel, 20))}</text>
          </g>
        `;
      }
    });

    this.svg.innerHTML = `
      <title>Interactive Network Topology Map</title>
      <g class="topo-root-group" transform="translate(${this.panX}, ${this.panY}) scale(${this.zoom})">
        <!-- Links Layer -->
        <g class="topo-links-layer">${linksSvg}</g>
        <!-- Nodes Layer -->
        <g class="topo-nodes-layer">${nodesSvg}</g>
      </g>
    `;

    // Attach click & keyboard events
    this.svg.querySelectorAll('.topo-node').forEach((nodeEl) => {
      const activateNode = () => {
        const id = nodeEl.getAttribute('data-id');
        const mac = nodeEl.getAttribute('data-mac');

        if (id) {
          this.selectNode(id);
          const found = this.nodes.find((n) => n.id === id);
          if (found && this.onNodeClick) this.onNodeClick(found);
        } else if (mac) {
          const foundClient = this.clients.find((c) => c.mac === mac);
          if (foundClient && this.onNodeClick) this.onNodeClick(foundClient);
        }
      };

      nodeEl.addEventListener('click', activateNode);
      nodeEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          activateNode();
        } else if (e.key === ' ') {
          e.preventDefault();
        }
      });
      nodeEl.addEventListener('keyup', (e) => {
        if (e.key === ' ') {
          activateNode();
        }
      });
    });
  }
}
