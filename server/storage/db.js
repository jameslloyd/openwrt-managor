import path from 'node:path';
import { config } from '../config.js';
import { readJson, writeJsonAtomic } from './atomic.js';

const getPath = (fileName) => path.join(config.dataDir, fileName);

export const defaultSettings = {
  pollIntervalMs: 10000,
  demoMode: false,
  retention: {
    maxBackupsPerHost: 10,
    maxAgeDays: 30,
    minRetainedPerHost: 2,
  },
  alerts: {
    highCpuThresholdPct: 85,
    highMemoryThresholdPct: 90,
    wifiInterferenceAlerts: true,
  },
};

export const defaultSchedules = [
  {
    id: 'sched-nightly-fleet',
    name: 'Nightly Fleet Backup',
    cron: '0 3 * * *',
    enabled: true,
    targets: ['all'],
    retentionMaxBackups: 14,
    lastRun: new Date().toISOString(),
    nextRun: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  },
];

export class Database {
  constructor(dataDir = config.dataDir) {
    this.dataDir = dataDir;
  }

  getFilePath(name) {
    return path.join(this.dataDir, name);
  }

  async init() {
    // Initialize settings if missing
    const settings = await this.getSettings();
    if (!settings) {
      await this.saveSettings(defaultSettings);
    }

    // Initialize schedules if missing
    const schedules = await this.getSchedules();
    if (!schedules || schedules.length === 0) {
      await this.saveSchedules(defaultSchedules);
    }

    // Initialize hosts if missing
    const hosts = await this.getHosts();
    if (!hosts) {
      await this.saveHosts([]);
    }

    // Initialize client aliases if missing
    const aliases = await this.getClientAliases();
    if (!aliases) {
      await this.saveClientAliases({});
    }

    // Initialize metrics history if missing
    const history = await this.getHistory();
    if (!history) {
      await this.saveHistory([]);
    }
  }

  async getHosts() {
    return readJson(this.getFilePath('hosts.json'), null);
  }

  async saveHosts(hosts) {
    await writeJsonAtomic(this.getFilePath('hosts.json'), hosts);
  }

  async getSettings() {
    return readJson(this.getFilePath('settings.json'), null);
  }

  async saveSettings(settings) {
    await writeJsonAtomic(this.getFilePath('settings.json'), settings);
  }

  async getSchedules() {
    return readJson(this.getFilePath('schedules.json'), null);
  }

  async saveSchedules(schedules) {
    await writeJsonAtomic(this.getFilePath('schedules.json'), schedules);
  }

  async getClientAliases() {
    return readJson(this.getFilePath('client_aliases.json'), {});
  }

  async saveClientAliases(aliases) {
    await writeJsonAtomic(this.getFilePath('client_aliases.json'), aliases);
  }

  async getHistory() {
    return readJson(this.getFilePath('history.json'), []);
  }

  async saveHistory(history) {
    await writeJsonAtomic(this.getFilePath('history.json'), history);
  }
}

export const db = new Database();
