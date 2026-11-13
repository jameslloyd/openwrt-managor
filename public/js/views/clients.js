/**
 * OpenWrt Manager (openwrt-managor)
 * Network Hosts & Clients View
 */

import { store } from '../store.js';
import { DataTable } from '../components/table.js';
import { toast } from '../components/toast.js';
import { formatBps, formatRssi, formatMac, escapeHtml } from '../utils/formatters.js';
import { renderIcon } from '../utils/icons.js';

let tableInstance = null;
let currentSearchQuery = '';
let currentFilterType = 'all';

export function renderClients(container) {
  const { clients } = store.state;

  container.innerHTML = `
    <div class="view-header">
      <div class="view-title-group">
        <h1>Network Hosts & Clients</h1>
        <p>Unified directory of all DHCP leases, ARP entries, and multi-AP wireless stations</p>
      </div>
      <div class="view-actions">
        <button type="button" class="btn btn-secondary" id="clients-export-csv">
          ${renderIcon('download', 'icon')} Export CSV
        </button>
      </div>
    </div>

    <div class="table-container">
      <div class="table-toolbar">
        <div class="search-box">
          ${renderIcon('search', 'search-icon')}
          <input type="search" id="client-search-input" class="search-input" placeholder="Search hostname, IP, MAC, vendor..." aria-label="Search clients" />
          <span class="search-shortcut-hint">/</span>
        </div>

        <div class="filter-chips">
          <button type="button" class="chip-btn active" data-filter="all">All (${clients.length})</button>
          <button type="button" class="chip-btn" data-filter="wired">Wired</button>
          <button type="button" class="chip-btn" data-filter="wifi_2g">2.4 GHz</button>
          <button type="button" class="chip-btn" data-filter="wifi_5g">5 GHz</button>
          <button type="button" class="chip-btn" data-filter="wifi_6g">6 GHz</button>
          <button type="button" class="chip-btn" data-filter="weak">Weak Signal (&lt; -70 dBm)</button>
        </div>
      </div>

      <div id="clients-table-mount"></div>
    </div>
  `;

  const mount = container.querySelector('#clients-table-mount');

  tableInstance = new DataTable({
    container: mount,
    columns: [
      {
        key: 'hostname',
        label: 'Device / Vendor',
        sortable: true,
        render: (c) => `
          <div>
            <div style="font-weight: 600; color: var(--color-text-primary);">${escapeHtml(c.displayName || c.nickname || c.hostname || c.ip)}</div>
            <div style="font-size: 11px; color: var(--color-text-muted);">${(c.nickname || c.displayName) ? escapeHtml(c.hostname) + ' • ' : ''}${escapeHtml(c.vendor || 'Unknown Manufacturer')}</div>
          </div>
        `
      },
      {
        key: 'ip',
        label: 'IP Address',
        sortable: true,
        render: (c) => `
          <div>
            <div class="font-mono" style="font-weight: 600;">${c.ip}</div>
            <div style="font-size: 11px; color: var(--color-text-secondary);">${c.isGuest ? 'Guest VLAN 10' : 'Main VLAN 1'}</div>
          </div>
        `
      },
      {
        key: 'mac',
        label: 'MAC Address',
        sortable: true,
        render: (c) => `
          <div>
            <div class="font-mono">${formatMac(c.mac)}</div>
            <div style="font-size: 10px; color: var(--color-text-muted);">Lease: ${Math.floor((c.dhcpLeaseRemainingSec || 36000) / 3600)}h rem</div>
          </div>
        `
      },
      {
        key: 'connectedTo',
        label: 'Connected AP',
        sortable: false,
        render: (c) => `
          <div style="display: flex; align-items: center; gap: 6px;">
            ${renderIcon(c.connectionType === 'wired' ? 'server' : 'wifi', 'icon')}
            <span>${escapeHtml(c.connectedTo?.hostName || c.connectedTo?.hostId || 'Gateway')}</span>
          </div>
        `
      },
      {
        key: 'signalDbm',
        label: 'Signal (RSSI)',
        sortable: true,
        render: (c) => {
          if (c.connectionType === 'wired') {
            return `<span style="color: var(--color-text-muted); font-size: 12px;">Wired Port</span>`;
          }
          const rssi = formatRssi(c.signalDbm);
          return `
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="signal-gauge ${rssi.colorClass}" title="${rssi.dbm} (${rssi.label}, SNR: ${c.snrDb || 40} dB)">
                <div class="signal-bar"></div>
                <div class="signal-bar"></div>
                <div class="signal-bar"></div>
                <div class="signal-bar"></div>
                <div class="signal-bar"></div>
              </div>
              <div>
                <div style="font-weight: 600; font-size: 12px;">${rssi.dbm}</div>
                <div style="font-size: 10px; color: var(--color-text-muted);">${rssi.label}</div>
              </div>
            </div>
          `;
        }
      },
      {
        key: 'rxRateMbps',
        label: 'PHY Rates',
        sortable: true,
        render: (c) => {
          if (c.connectionType === 'wired') return `<span class="font-mono">1.0 Gbps</span>`;
          return `<div class="font-mono" style="font-size: 11px;">${c.rxRateMbps || 0}M / ${c.txRateMbps || 0}M</div>`;
        }
      },
      {
        key: 'rxRateBps',
        label: 'Live Traffic',
        sortable: true,
        render: (c) => `
          <div style="font-size: 11.5px;">
            <div style="color: var(--color-primary); font-weight: 600;">↓ ${formatBps(c.rxRateBps)}</div>
            <div style="color: var(--color-success);">↑ ${formatBps(c.txRateBps)}</div>
          </div>
        `
      },
      {
        key: 'actions',
        label: '',
        sortable: false,
        render: (c) => `
          <button type="button" class="btn btn-ghost" style="padding: 4px 8px; font-size: 11px;" title="Inspect device">
            ${renderIcon('activity', 'icon')} Details
          </button>
        `
      }
    ],
    rows: getFilteredClients(),
    onRowClick: (client) => {
      store.selectClient(client);
    }
  });

  tableInstance.render();

  // Search input handler
  const searchInput = container.querySelector('#client-search-input');
  searchInput?.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value.toLowerCase().trim();
    tableInstance.setRows(getFilteredClients());
  });

  // Filter chips handler
  const chips = container.querySelectorAll('.chip-btn');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilterType = chip.getAttribute('data-filter') || 'all';
      tableInstance.setRows(getFilteredClients());
    });
  });

  // Export CSV
  container.querySelector('#clients-export-csv')?.addEventListener('click', () => {
    exportClientsCsv(getFilteredClients());
  });
}

function getFilteredClients() {
  const { clients } = store.state;
  return clients.filter(c => {
    // Type Filter
    if (currentFilterType === 'wired' && c.connectionType !== 'wired') return false;
    if (currentFilterType === 'wifi_2g' && c.connectionType !== 'wifi_2g') return false;
    if (currentFilterType === 'wifi_5g' && c.connectionType !== 'wifi_5g') return false;
    if (currentFilterType === 'wifi_6g' && c.connectionType !== 'wifi_6g') return false;
    if (currentFilterType === 'weak' && (c.connectionType === 'wired' || (c.signalDbm ?? 0) >= -70)) return false;

    // Search Query
    if (currentSearchQuery) {
      const match =
        (c.hostname && c.hostname.toLowerCase().includes(currentSearchQuery)) ||
        (c.ip && c.ip.includes(currentSearchQuery)) ||
        (c.mac && c.mac.toLowerCase().includes(currentSearchQuery)) ||
        (c.vendor && c.vendor.toLowerCase().includes(currentSearchQuery));
      if (!match) return false;
    }

    return true;
  });
}

function exportClientsCsv(clientList) {
  const headers = ['Hostname', 'IP Address', 'MAC Address', 'Vendor', 'Connection Type', 'Signal (dBm)', 'Connected AP'];
  const rows = clientList.map(c => [
    `"${c.hostname || ''}"`,
    `"${c.ip || ''}"`,
    `"${c.mac || ''}"`,
    `"${c.vendor || ''}"`,
    `"${c.connectionType || ''}"`,
    `"${c.signalDbm ?? 'N/A'}"`,
    `"${c.connectedTo?.hostName || c.connectedTo?.hostId || ''}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `openwrt-clients-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('Export Complete', 'Saved network clients as CSV.');
}
