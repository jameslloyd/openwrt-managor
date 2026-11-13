import { simulator } from './simulator.js';
import { db } from '../storage/db.js';

export class ClientEngine {
  async getClients(filter = {}) {
    const clients = simulator.getClients(filter);
    const aliases = (await db.getClientAliases()) || {};

    return clients.map((c) => {
      const alias = aliases[c.mac.toLowerCase()];
      return {
        ...c,
        nickname: alias || null,
        displayName: alias || c.hostname,
      };
    });
  }

  async getClientByMac(mac) {
    const client = simulator.getClientByMac(mac);
    if (!client) return null;

    const aliases = (await db.getClientAliases()) || {};
    const alias = aliases[client.mac.toLowerCase()];

    return {
      ...client,
      nickname: alias || null,
      displayName: alias || client.hostname,
    };
  }

  async setClientAlias(mac, nickname) {
    if (!mac || typeof mac !== 'string') return null;
    const normalized = mac.toLowerCase().trim();
    if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(normalized)) {
      throw new Error('Invalid MAC address format');
    }
    if (normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') {
      throw new Error('Invalid identifier');
    }

    const rawAliases = (await db.getClientAliases()) || {};
    const aliases = Object.assign(Object.create(null), rawAliases);
    if (nickname) {
      aliases[normalized] = String(nickname).slice(0, 100);
    } else {
      delete aliases[normalized];
    }
    await db.saveClientAliases({ ...aliases });
    return this.getClientByMac(mac);
  }
}

export const clientEngine = new ClientEngine();
