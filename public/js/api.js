/**
 * OpenWrt Manager (openwrt-managor)
 * Typed API Client & Background Poller
 */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(url, options = {}) {
  const config = {
    headers: {
      'Accept': 'application/json',
      ...options.headers
    },
    ...options
  };

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }

  let res;
  try {
    res = await fetch(url, config);
  } catch (err) {
    throw new ApiError(`Network connection error: ${err.message}`, 0, 'NETWORK_ERROR');
  }

  // Handle download stream or non-json responses
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/octet-stream') || contentType.includes('application/gzip')) {
    if (!res.ok) throw new ApiError(`Download failed with status ${res.status}`, res.status);
    return res;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errorMsg = data?.message || res.statusText || `Request failed with status ${res.status}`;
    throw new ApiError(errorMsg, res.status, data?.code);
  }

  return data;
}

export const api = {
  // System & Health
  getHealth: () => request('/api/health'),
  getSystemInfo: () => request('/api/system/info'),
  getSettings: () => request('/api/settings'),
  updateSettings: (data) => request('/api/settings', { method: 'PUT', body: data }),
  regenerateAgentApiKey: () => request('/api/settings/agent-key/regenerate', { method: 'POST' }),

  // Hermes & External Agent REST API
  getAgentStatus: (apiKey = '') =>
    request('/api/agent/status', {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
    }),
  getAgentManifest: () => request('/api/agent/manifest'),
  getOpenApiSpec: () => request('/api/openapi.json'),

  // Hosts
  getHosts: (refresh = false) => request(`/api/hosts${refresh ? '?refresh=true' : ''}`),
  refreshHosts: (hostId = 'all', full = true) =>
    hostId === 'all'
      ? request('/api/hosts/refresh', { method: 'POST', body: { hostId: 'all', full } })
      : request(`/api/hosts/${encodeURIComponent(hostId)}/refresh`, { method: 'POST', body: { full } }),
  getHost: (id) => request(`/api/hosts/${encodeURIComponent(id)}`),
  createHost: (data) => request('/api/hosts', { method: 'POST', body: data }),
  updateHost: (id, data) => request(`/api/hosts/${encodeURIComponent(id)}`, { method: 'PUT', body: data }),
  deleteHost: (id, deleteBackups = false) =>
    request(`/api/hosts/${encodeURIComponent(id)}?deleteBackups=${deleteBackups}`, { method: 'DELETE' }),
  testHostConnection: (idOrData) => {
    if (typeof idOrData === 'string') {
      return request(`/api/hosts/${encodeURIComponent(idOrData)}/test`, { method: 'POST' });
    }
    return request('/api/hosts/test', { method: 'POST', body: idOrData });
  },
  getHostUpdates: (id) => request(`/api/hosts/${encodeURIComponent(id)}/updates`),
  getUpgradeJobs: (activeOnly = false) =>
    request(`/api/hosts/updates/jobs${activeOnly ? '?activeOnly=true' : ''}`),
  getHostUpgradeJob: (id) => request(`/api/hosts/${encodeURIComponent(id)}/updates/job`),
  checkHostUpdates: (id = 'all') =>
    id === 'all'
      ? request('/api/hosts/updates/check', { method: 'POST', body: { hostId: 'all' } })
      : request(`/api/hosts/${encodeURIComponent(id)}/updates/check`, { method: 'POST' }),
  upgradeHostPackages: (id, packages = 'all') =>
    request(`/api/hosts/${encodeURIComponent(id)}/updates/upgrade`, { method: 'POST', body: { packages } }),
  runAttendedSysupgrade: (id, action = 'check') =>
    request(`/api/hosts/${encodeURIComponent(id)}/updates/attended-sysupgrade`, { method: 'POST', body: { action } }),

  // Topology
  getTopology: () => request('/api/topology'),

  // Clients
  getClients: (params = {}) => {
    const searchParams = new URLSearchParams();
    if (params.q) searchParams.set('q', params.q);
    if (params.hostId) searchParams.set('hostId', params.hostId);
    if (params.type) searchParams.set('type', params.type);
    if (params.vlan) searchParams.set('vlan', params.vlan);
    const query = searchParams.toString();
    return request(`/api/clients${query ? '?' + query : ''}`);
  },
  getClient: (mac) => request(`/api/clients/${encodeURIComponent(mac)}`),
  setClientAlias: (mac, nickname) =>
    request(`/api/clients/${encodeURIComponent(mac)}/alias`, { method: 'PUT', body: { nickname } }),

  // WiFi & Spectrum
  getWifiChannels: () => request('/api/wifi/channels'),
  getWifiInterference: () => request('/api/wifi/interference'),
  scanWifiNetworks: (hostId = 'all') => request('/api/wifi/scan', { method: 'POST', body: { hostId } }),

  // Backups
  getBackups: () => request('/api/backups'),
  runBackup: (hostId = 'all') => request('/api/backups/run', { method: 'POST', body: { hostId } }),
  getBackupDownloadUrl: (id) => `/api/backups/${encodeURIComponent(id)}/download`,
  getBackupFiles: (id) => request(`/api/backups/${encodeURIComponent(id)}/files`),
  getBackupFileContent: (id, filePath) =>
    request(`/api/backups/${encodeURIComponent(id)}/file-content?path=${encodeURIComponent(filePath)}`),
  getBackupDiff: (id, otherId, filePath) => {
    const q = filePath ? `?file=${encodeURIComponent(filePath)}` : '';
    return request(`/api/backups/${encodeURIComponent(id)}/diff/${encodeURIComponent(otherId)}${q}`);
  },
  deleteBackup: (id) => request(`/api/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Backup Schedules
  getBackupSchedules: () => request('/api/backups/schedules'),
  updateBackupSchedules: (data) => request('/api/backups/schedules', { method: 'PUT', body: data }),
  runBackupSchedule: (id) => request(`/api/backups/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' }),

  // Simulator
  getSimulatorStatus: () => request('/api/simulator/status'),
  configureSimulator: (params) => request('/api/simulator/configure', { method: 'POST', body: params }),
  resetSimulator: () => request('/api/simulator/reset', { method: 'POST' })
};

export default api;
