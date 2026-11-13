# OpenWrt Manager (`openwrt-managor`)

[![Docker](https://img.shields.io/badge/Docker-TrueNAS%20SCALE-0078d4?logo=docker&logoColor=white)](https://www.truenas.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B%20LTS-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![OpenWrt](https://img.shields.io/badge/OpenWrt-21.02%20|%2022.03%20|%2023.05%2B-0082c9?logo=openwrt&logoColor=white)](https://openwrt.org/)
[![Architecture](https://img.shields.io/badge/Architecture-Pure%20ESM%20%7C%20Zero--Bundler-f59e0b)](#system-architecture--design)
[![Tests](https://img.shields.io/badge/Tests-21%20Passing-10b981?logo=checkmarx&logoColor=white)](#testing--quality-assurance)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**OpenWrt Manager** is a high-performance, lightweight, self-hosted web management console engineered specifically to run in Docker on **TrueNAS SCALE** (or any Docker/Linux host). It unifies the monitoring, visualization, and automated configuration backups for fleets of OpenWrt routers, access points (APs), and wireless mesh extenders.

Out of the box, it features a built-in **Live Multi-Host Telemetry Simulator** generating realistic homelab network traffic, multi-band Wi-Fi channels, and client roaming behavior—allowing immediate evaluation without hardware, while providing seamless connectivity to physical OpenWrt hardware via HTTP `ubus` RPC and SSH `sysupgrade -b`.

---

## Table of Contents
- [Screenshots Gallery](#screenshots-gallery)
- [Key Features](#key-features)
- [System Architecture & Design](#system-architecture--design)
  - [High-Level Architecture](#high-level-architecture)
  - [Hybrid Real Hardware & Simulator Pipeline](#hybrid-real-hardware--simulator-pipeline)
  - [Multi-AP Client De-Duplication & Roaming Resolution](#multi-ap-client-de-duplication--roaming-resolution)
  - [Automated Backup, Retention & UCI Diff Pipeline](#automated-backup-retention--uci-diff-pipeline)
- [TrueNAS SCALE Docker Deployment Guide](#truenas-scale-docker-deployment-guide)
  - [Docker Compose Configuration](#docker-compose-configuration)
  - [ZFS Dataset Recommendations](#zfs-dataset-recommendations)
  - [Environment Variables](#environment-variables)
- [Quick Start Guide](#quick-start-guide)
  - [Running Locally](#running-locally)
  - [Connecting Physical OpenWrt Routers](#connecting-physical-openwrt-routers)
- [REST API Reference Summary](#rest-api-reference-summary)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [Documentation Links](#documentation-links)
- [License](#license)

---

## Screenshots Gallery

### 1. Overview Dashboard
Real-time fleet health, KPI metric summary cards, live dual-line WAN/LAN SVG throughput sparkline, router hardware utilization bars (CPU/RAM), and event activity stream.
![Overview Dashboard](docs/screenshots/dashboard.png)

---

### 2. Interactive Network Topology Map
Hierarchical multi-tier network graph (Tier 0 WAN &rarr; Tier 1 Main Gateway &rarr; Tier 2 Secondary APs & Mesh Backhaul &rarr; Tier 3 Wired and Wireless Clients) with color-coded negotiated link speeds (10G/2.5G/1G/100M/Mesh), animated active packet traffic, and slide-out node inspector drawer.
![Network Topology Map](docs/screenshots/topology.png)

---

### 3. Tri-Band Wi-Fi RF Spectrum & Channel Coverage Analyzer
Visual RF spectrum analyzer covering 2.4 GHz, 5 GHz (UNII-1, UNII-2/DFS, UNII-3), and 6 GHz (UNII-5 through UNII-8). Displays mathematical 20/40/80/160 MHz parabolic signal curves, channel centers, ambient noise floors, and automated co-channel / adjacent-channel interference warning overlays.
![Wi-Fi Spectrum Analyzer](docs/screenshots/wifi-spectrum.png)

---

### 4. Network Hosts & Clients Inventory
Consolidated client table aggregating DHCP leases, ARP entries, and multi-AP `iwinfo` association lists. Features instant search, multi-facet filtering (Host, Band, VLAN, Weak Signal), 5-bar RSSI/SNR signal gauges, real-time throughput metrics, and client roaming history.
![Network Hosts & Clients Inventory](docs/screenshots/clients.png)

---

### 5. TrueNAS Backups & Side-by-Side UCI Config Diff Viewer
Automated cron/interval backup engine with persistent TrueNAS ZFS storage tracking, one-click manual backups, SHA-256 integrity verification, in-memory `.tar.gz` archive inspection, and high-contrast side-by-side UCI configuration diff modal (`network`, `wireless`, `firewall`, `dhcp`, `system`).
![TrueNAS Backups & Config Diff](docs/screenshots/backups-diff.png)

---

## Key Features

- **TrueNAS SCALE Native:** Designed from the ground up for TrueNAS SCALE Docker deployment with decoupled `/data` (application configuration) and `/backups` (OpenWrt `.tar.gz` configuration archives) volumes, unprivileged execution (`node` user UID/GID 1000), and automated health checks.
- **Hybrid Real & Simulated Operation:** Works instantly out of the box with a rich 4-node simulated homelab fleet (Dual-2.5G Gateway, Wi-Fi 6 Living Room AP, Wi-Fi 6 Office AP, Wi-Fi 5 Mesh AP, and 22 active client devices), while fully supporting physical OpenWrt devices via HTTP `ubus` JSON-RPC and SSH.
- **Zero-Bundler Modern Web Frontend:** Pure native ES Modules (ESM) with zero Webpack/Vite build steps, native CSS Custom Properties, semantic HTML5 `<dialog>` modals, and responsive layout for desktop, tablet, and mobile browsers.
- **Multi-AP Client De-Duplication:** Resolves roaming clients across multiple access points by correlating Wi-Fi association inactive times, signal strengths, DHCP leases, and IEEE OUI vendor hardware lookups.
- **Tri-Band Wi-Fi Spectrum Visualizer:** Generates mathematical spectral bandwidth masks (20, 40, 80, 160 MHz) and alerts network administrators to co-channel contention and adjacent-channel degradation.
- **Automated Configuration Backup & Inspection Engine:** Scheduled cron/interval backups per router, SHA-256 checksum tracking, automated retention policy pruning, zero-temporary-file in-memory `.tar.gz` UCI configuration extraction, and side-by-side colorized diffing.
- **Atomic Flat-File Storage Engine:** Zero external database dependencies; app configuration and schedules are written atomically using a write-to-temp, `fsync`, and atomic rename pattern (`0o600` permissions) preventing corruption during sudden NAS power loss.

---

## System Architecture & Design

### High-Level Architecture

```mermaid
flowchart TD
    subgraph ClientBrowser["Client Browser (Zero-Bundler Modern Web UI)"]
        UI_SPA["Single Page App (public/index.html)"]
        UI_Views["Views: Dashboard | Topology | Spectrum | Clients | Backups | Settings"]
        UI_Charts["SVG Charts: Topology Graph | RF Spectrum Analyzer | WAN/LAN Sparkline"]
        UI_Client["API Polling & SSE Client (public/js/api.js)"]
    end

    subgraph TrueNASContainer["TrueNAS SCALE Docker Container (openwrt-managor)"]
        subgraph ServerRuntime["Node.js Application Server (Port 8080)"]
            StaticServer["Static File Server (public/)"]
            APIRouter["REST API Router (/api/*)"]
            HealthEndpoint["Health Check Handler (/api/health)"]

            subgraph CoreEngines["Core Subsystems"]
                HostMgr["Host Manager & Polling Engine"]
                TopoEngine["Topology & Metrics Synthesizer"]
                ClientEngine["Client Inventory & Roaming Engine"]
                WifiEngine["Wi-Fi Spectrum & Interference Analyzer"]
                BackupEngine["Backup Scheduler & Retention Runner"]
                DiffEngine["In-Memory Tarball & UCI Diff Engine"]
            end

            subgraph Adapters["OpenWrt Connection Adapters"]
                UbusAdapter["Real OpenWrt HTTP ubus RPC Client"]
                SSHAdapter["Real OpenWrt SSH sysupgrade Client"]
                SimEngine["Live Multi-Host Telemetry Simulator"]
            end

            subgraph StorageEngine["Atomic JSON Flat-File Storage"]
                AtomicWriter["Atomic File Writer (fsync + rename)"]
            end
        end

        subgraph StorageVolumes["TrueNAS Host ZFS Datasets"]
            DataMount["/data Volume (hosts.json, settings.json, schedules.json)"]
            BackupMount["/backups Volume (host_id/*.tar.gz, *.meta.json)"]
        end
    end

    subgraph PhysicalFleet["Physical OpenWrt Fleet"]
        GW["Main Gateway Router (x86_64 / ARM)"]
        AP1["Access Point 1 (Wi-Fi 6)"]
        AP2["Access Point 2 (Wi-Fi 6)"]
    end

    UI_Client <--> APIRouter
    UI_SPA --> StaticServer
    APIRouter --> CoreEngines
    HostMgr --> Adapters
    Adapters --> GW
    Adapters --> AP1
    Adapters --> AP2
    StorageEngine <--> DataMount
    BackupEngine <--> BackupMount
```

---

### Hybrid Real Hardware & Simulator Pipeline

```mermaid
flowchart LR
    HostConfig["Host Configuration Record"]
    RouterSelector{"Is Host Simulated?"}
    
    subgraph SimulationTrack["Virtual Homelab Track (Demo Mode)"]
        SimRunner["Telemetry Simulator Engine"]
        SimData["Generate Realistic CPU, RAM, Interfaces, iwinfo, DHCP & Traffic Jitter"]
        SimTarball["Generate Valid OpenWrt .tar.gz with Realistic UCI Files"]
    end

    subgraph HardwareTrack["Physical OpenWrt Hardware Track"]
        UbusClient["HTTP ubus JSON-RPC (POST /ubus)"]
        SSHClient["SSH sysupgrade -b - Execution"]
        RealData["Real-Time ubus Telemetry (system, network, iwinfo, luci-rpc)"]
        RealTarball["Physical OpenWrt sysupgrade Backup Stream"]
    end

    UnifiedNorm["Unified Normalization Layer"]
    Aggregator["Topology, Inventory, Spectrum & Backup Engines"]

    HostConfig --> RouterSelector
    RouterSelector -- "isSimulated: true" --> SimRunner --> SimData --> UnifiedNorm
    SimRunner --> SimTarball --> UnifiedNorm
    RouterSelector -- "isSimulated: false" --> UbusClient --> RealData --> UnifiedNorm
    SSHClient --> RealTarball --> UnifiedNorm
    UnifiedNorm --> Aggregator
```

---

### Multi-AP Client De-Duplication & Roaming Resolution

```mermaid
sequenceDiagram
    autonumber
    participant Engine as Client Inventory Engine
    participant GW as Gateway (node-gw-01)
    participant AP1 as Living Room AP (node-ap-01)
    participant AP2 as Office AP (node-ap-02)

    Engine->>GW: Poll DHCP leases & ARP tables
    GW-->>Engine: 22 Active IPv4/IPv6 Leases (IP, MAC, Hostname, Expiry)
    Engine->>AP1: Poll iwinfo assoclist
    AP1-->>Engine: 8 Wi-Fi Stations (MAC, RSSI: -79 dBm, Inactive: 4200ms)
    Engine->>AP2: Poll iwinfo assoclist
    AP2-->>Engine: 11 Wi-Fi Stations (MAC, RSSI: -54 dBm, Inactive: 80ms)

    Note over Engine: Client MAC 48:2a:e3:11:22:33 appears on AP1 and AP2.<br/>AP2 is authoritative (lower inactive time, stronger RSSI).<br/>Record flagged as 'recently_roamed: true'
    Engine->>Engine: Match IEEE OUI Vendor & Subnet/VLAN mapping
    Engine-->>Engine: Emit Single Consolidated Client Record
```

---

### Automated Backup, Retention & UCI Diff Pipeline

```mermaid
stateDiagram-v2
    [*] --> Idle: Backup Scheduler Trigger or Manual Request
    Idle --> InProgress: Lock Host & Allocate Job ID
    InProgress --> Fetching: Stream sysupgrade -b from OpenWrt
    Fetching --> Hashing: Verify Gzip & Compute SHA-256 Checksum
    Hashing --> Storing: Write /backups/{hostId}/backup_{timestamp}.tar.gz
    Storing --> Metadata: Write /backups/{hostId}/backup_{timestamp}.meta.json
    Metadata --> RetentionPruning: Evaluate Retention Policy (Max Count / Max Age)
    RetentionPruning --> Complete: Update Last Backup Status & Release Lock
    Complete --> [*]

    Fetching --> Failed: Network Timeout / Auth Failure
    Storing --> Failed: Storage Full / Write Error
    Failed --> Complete: Record Failure Alert & Release Lock
```

For complete technical specifications, see:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) &mdash; Complete System Architecture, Data Contracts, Storage Protocols & REST API Catalog
- [docs/UX_SPEC.md](docs/UX_SPEC.md) &mdash; Detailed UX Specification, User Journeys, WCAG 2.2 AA Accessibility & Interaction States

---

## TrueNAS SCALE Docker Deployment Guide

### Docker Compose Configuration

Create a custom application in TrueNAS SCALE (or run via standard Docker Compose):

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
   - Stores `hosts.json`, `settings.json`, and `schedules.json`.
   - Permissions: UID `1000`, GID `1000` (Node.js runtime user).
2. `/mnt/pool/backups/openwrt`:
   - Stores gzip `.tar.gz` configuration archives and `.meta.json` sidecar files.
   - Recommended ZFS dataset options: `compression=zstd` (or `lz4`), regular ZFS snapshots.

### Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Integer | `8080` | Internal HTTP listening port |
| `DATA_DIR` | String | `/data` | Path to persistent database directory |
| `BACKUP_DIR` | String | `/backups` | Path to persistent configuration backup storage |
| `DEMO_MODE` | Boolean | `true` | When true, activates live multi-host simulator when no hosts exist |
| `POLL_INTERVAL_MS`| Integer | `10000` | Background host telemetry polling interval (ms) |
| `BACKUP_TIMEOUT_MS`| Integer | `30000` | Timeout for router backup operations (ms) |
| `LOG_LEVEL` | String | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

---

## Quick Start Guide

### Running Locally

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

The application starts immediately in **Demo Mode**, displaying the 4-node simulated homelab network with live traffic, Wi-Fi channel spectrums, and clients.

### Connecting Physical OpenWrt Routers

1. Ensure the router has `rpcd-mod-luci` or `uhttpd-mod-ubus` enabled:
   ```bash
   opkg update
   opkg install rpcd-mod-luci uhttpd-mod-ubus
   /etc/init.d/rpcd restart
   /etc/init.d/uhttpd restart
   ```
2. In OpenWrt Manager, click **"Add OpenWrt Host"**.
3. Enter the router IP, HTTP port (default `80`), username (`root`), and password.
4. Click **"Test Connection"** to verify real-time connectivity, detected model, and firmware version.
5. Save the host to start automated polling and backups.

---

## REST API Reference Summary

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Container healthcheck (status, uptime, storage checks) |
| `GET` | `/api/system/info` | Host system info, Node runtime, memory usage |
| `GET` | `/api/settings` | Global settings (poll interval, retention rules, alerts) |
| `PUT` | `/api/settings` | Update global settings |
| `GET` | `/api/hosts` | List all managed OpenWrt routers and APs |
| `POST` | `/api/hosts` | Register a new OpenWrt host |
| `GET` | `/api/hosts/:id` | Get single host configuration and telemetry |
| `PUT` | `/api/hosts/:id` | Update host configuration |
| `DELETE`| `/api/hosts/:id` | Delete host from fleet |
| `POST` | `/api/hosts/test` | Test credentials and connectivity for unsaved host |
| `POST` | `/api/hosts/:id/test` | Test credentials and connectivity for registered host |
| `GET` | `/api/topology` | Synthesized network topology graph (`nodes` & `links`) |
| `GET` | `/api/clients` | Searchable, filterable network client inventory |
| `GET` | `/api/clients/:mac` | Client detail view with roaming and signal history |
| `GET` | `/api/wifi/channels` | Tri-band (2.4/5/6 GHz) spectrum dataset & radios |
| `GET` | `/api/wifi/interference`| Co-channel and adjacent-channel interference warnings |
| `GET` | `/api/backups` | List all stored OpenWrt backup archives and metadata |
| `POST` | `/api/backups/run` | Execute on-demand configuration backup (`hostId: "all"`) |
| `GET` | `/api/backups/:id/download` | Stream `.tar.gz` archive download |
| `GET` | `/api/backups/:id/files` | In-memory listing of archive files |
| `GET` | `/api/backups/:id/file-content` | Stream textual content of a specific UCI file |
| `GET` | `/api/backups/:id/diff/:otherId` | Unified line-by-line diff between two backups |
| `DELETE`| `/api/backups/:id` | Delete a backup archive and sidecar metadata |
| `GET` | `/api/backups/schedules` | View automated cron backup schedules |
| `PUT` | `/api/backups/schedules` | Update automated cron backup schedules |
| `POST` | `/api/backups/schedules/:id/run` | Immediately execute a backup schedule |
| `GET` | `/api/simulator/status` | Simulator status and active mock topology state |
| `POST` | `/api/simulator/configure` | Adjust simulation parameters (roaming, traffic spike) |
| `POST` | `/api/simulator/reset` | Reseed default homelab fleet |

---

## Testing & Quality Assurance

The test suite runs using Node.js's native test runner (`node:test` and `node:assert`) with **zero external test dependencies**:

```bash
npm test
```

### Test Suite Highlights (21 Passing Tests):
- **Health & System Info:** Validates 200 responses, memory metrics, and volume availability.
- **Host Management & Probes:** Validates CRUD operations, credential masking, and live async connection testing.
- **Topology Synthesis:** Verifies multi-tier node hierarchies, edge capacities, throughput aggregation, and VLAN mapping.
- **Client De-Duplication & Roaming:** Verifies de-duplication across multi-AP association lists, RSSI arbitration, and OUI lookups.
- **Wi-Fi RF Spectrum & Overlap:** Verifies 2.4 GHz, 5 GHz, and 6 GHz spectrum models and co-channel interference detection.
- **Tarball Inspection & UCI Diff:** Verifies in-memory gzip tarball unpacking, file manifests, and colorized unified line diff generation.
- **Retention Pruning Engine:** Verifies max backup counts, age limits, and minimum retention guarantees.
- **Atomic Storage Engine:** Verifies collision-free atomic writes with `fsync` and `0o600` file mode permissions.

---

## Documentation Links

- [Architecture Specification (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md) &mdash; Complete technical blueprint, JSON schemas, protocol specifications, and container architecture.
- [UX Specification (`docs/UX_SPEC.md`)](docs/UX_SPEC.md) &mdash; Interaction states, user journeys, accessibility (WCAG 2.2 AA), and keyboard shortcuts.

---

## License

This project is licensed under the [MIT License](LICENSE).
