# Deployment & OpenWrt Setup Guide

[&larr; Back to Main README](../README.md)

This guide covers running **OpenWrt Manager (`openwrt-managor`)** locally, deploying it as a Docker container on **TrueNAS SCALE**, configuring ZFS datasets, and preparing physical OpenWrt routers and access points.

---

## 1. Quick Start (Local / Development)

```bash
# 1. Clone the repository
git clone https://github.com/jameslloyd/openwrt-managor.git
cd openwrt-managor

# 2. Install dependencies
npm install

# 3. Start the application
npm start

# 4. Open in browser
# Navigate to http://localhost:8080
```

Out of the box, the server starts in **Demo Mode** (`DEMO_MODE=true`), launching a 4-node simulated homelab network (Dual-2.5G Gateway, Wi-Fi 6 Living Room AP, Wi-Fi 6 Office AP, Wi-Fi 5 Mesh AP, and 22 active clients) when no physical hosts are configured.

---

## 2. TrueNAS SCALE Docker Deployment

### Docker Compose Configuration

Create a custom application in TrueNAS SCALE (or deploy via standard Docker Compose):

```yaml
version: "3.8"

services:
  openwrt-managor:
    image: openwrt-managor:latest
    build:
      context: .
      dockerfile: Dockerfile
    container_name: openwrt-managor
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - PORT=8080
      - DATA_DIR=/data
      - BACKUP_DIR=/backups
      - DEMO_MODE=true
      - POLL_INTERVAL_MS=10000
      - LOG_LEVEL=info
    volumes:
      # TrueNAS ZFS Datasets for persistent app state and backups
      - /mnt/pool/appdata/openwrt-managor/data:/data
      - /mnt/pool/backups/openwrt:/backups
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8080/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    labels:
      net.truenas.scale.description: "OpenWrt Multi-Host Fleet Manager and Backup Center"
```

### ZFS Dataset Recommendations

On TrueNAS SCALE, create two dedicated ZFS datasets:
1. `/mnt/pool/appdata/openwrt-managor/data`:
   - Stores `hosts.json`, `settings.json`, and `schedules.json` using atomic `fsync` + `rename` writes (`0o600` permissions).
   - Permissions: UID `1000`, GID `1000` (unprivileged Node.js runtime user).
2. `/mnt/pool/backups/openwrt`:
   - Stores gzip `.tar.gz` OpenWrt configuration archives and `.meta.json` sidecar files.
   - Recommended ZFS dataset options: `compression=zstd` (or `lz4`) with scheduled ZFS snapshots.

### Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Integer | `8080` | Internal HTTP listening port |
| `DATA_DIR` | String | `/data` | Path to persistent application state directory |
| `BACKUP_DIR` | String | `/backups` | Path to persistent configuration backup storage |
| `DEMO_MODE` | Boolean | `true` | Activates live multi-host simulator when no physical hosts exist |
| `POLL_INTERVAL_MS` | Integer | `10000` | Background host telemetry polling interval (ms) |
| `BACKUP_TIMEOUT_MS` | Integer | `30000` | Timeout for router backup operations (ms) |
| `OPENWRT_MANAGER_API_KEY` | String | *(unset)* | Optional API key (`Bearer` or `X-API-Key`) for Hermes / external agent endpoints |
| `LOG_LEVEL` | String | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

---

## 3. Connecting Physical OpenWrt Routers & APs

### Required OpenWrt Packages

OpenWrt Manager communicates with physical routers over **SSH** (port 22) and/or **HTTP `ubus` JSON-RPC**:

1. **Enable HTTP `ubus` RPC (Optional if using SSH transport):**
   ```bash
   opkg update
   opkg install rpcd-mod-luci uhttpd-mod-ubus
   /etc/init.d/rpcd restart
   /etc/init.d/uhttpd restart
   ```
2. **Enable Attended Sysupgrade Firmware Advisories (Optional):**
   To check for and install upgraded OpenWrt firmware releases with all installed packages preserved, install Attended Sysupgrade on your OpenWrt hosts:
   ```bash
   # OpenWrt 23.05 and earlier (opkg):
   opkg update && opkg install attendedsysupgrade-common luci-app-attendedsysupgrade auc

   # OpenWrt 24.10+ (opkg or apk):
   opkg update && opkg install owut luci-app-attendedsysupgrade
   ```

### Adding a Host in the UI

1. In OpenWrt Manager, navigate to **OpenWrt Hosts** (or **Settings**) and click **Add OpenWrt Host**.
2. Enter the router **Hostname / IP**, **Role** (`gateway`, `ap`, or `mesh`), **Username** (`root`), and **Password**.
3. *(Optional — For 3D Wi-Fi Triangulation)*: If the device has wireless radios, enter its **Latitude (°)**, **Longitude (°)**, and **Altitude (m)** so it can act as a geodetic anchor on the RF Triangulation map.
4. Click **Test Connection** to verify live connectivity, hardware model, and firmware version, then click **Save Host**.
