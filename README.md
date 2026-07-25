# luci-app-mullvad

A LuCI app for managing a Mullvad WireGuard tunnel on OpenWrt.

## Features

- **One-field setup** — enter your Mullvad account number and the router
  generates a WireGuard key, registers itself as a device via the Mullvad API,
  and creates the interface, peer and firewall configuration for you.
  Alternatively, paste a `.conf` file from Mullvad's config generator.
- **Relay browser** — country → city → relay selection from the live relay
  list, with Mullvad-owned / rented and drained relays labelled.
- **Find fastest relay** — Mullvad no longer publishes per-server load, so the
  app uses the two signals that exist: Mullvad's own load-balancing `weight`
  (0 = drained, higher = more capacity) to shortlist candidates, then pings
  them **from the router** and ranks them by measured round-trip time.
- **Automatic failover** — an optional watchdog pings the in-tunnel gateway
  (`10.64.0.1`); after 3 consecutive failures it rotates to the next relay
  (same city → same country → anywhere) and reloads the tunnel. Rotation is
  rate-limited so a dead WAN uplink doesn't churn through relays.
- **Connection check** — one click asks `am.i.mullvad.net` (through the
  router) whether traffic really exits via Mullvad.
- **Safe applies** — relay switches go through LuCI's connectivity-rollback
  mechanism: if the router becomes unreachable after a change, the previous
  configuration is restored automatically.

## Why not luci-app-mullvad (linakis)?

The original app breaks on current OpenWrt for structural reasons this app
avoids:

1. It requires `curl`, which stock OpenWrt images do not include.
   This app tries `uclient-fetch` (always present) first, then `curl`/`wget`.
2. It reads the multi-hundred-KB relay JSON into the browser through LuCI's
   `fs.read()`, which goes over ubus and hits the 1 MB message limit — the
   list "fails to download" even when the download worked.
   This app compacts the list **server-side** in an rpcd ucode plugin, so the
   browser receives ~100 KB.
3. It caches the whole JSON blob inside a UCI option value, which is fragile.
   This app caches to `/tmp/mullvad/relays.json` with a persistent seed copy
   in `/etc/mullvad/relays.json` so failover works right after boot.

## Requirements

- OpenWrt 23.05 or newer (uses ucode, which ships with firewall4/LuCI)
- Packages: `luci-base`, `luci-proto-wireguard`, `wireguard-tools`
  (`kmod-wireguard` is pulled in by `luci-proto-wireguard`)

```sh
opkg update && opkg install luci-proto-wireguard wireguard-tools
# or on apk-based builds:
apk add luci-proto-wireguard wireguard-tools
```

## Installation

### A. Upload through LuCI (opkg-based builds, ≤ 24.10 and most community builds)

1. Download `dist/luci-app-mullvad_1.0.0_all.ipk`.
2. LuCI → **System → Software → Upload Package…** → select the ipk → Install.
3. Log out of LuCI and back in (or hard-refresh). **Services → Mullvad VPN**.

### B. Script install (apk-based builds and development)

Newer OpenWrt (post-24.10, e.g. 25.x) replaced opkg with `apk`, which does not
accept ipk files. Use the installer script instead:

```sh
scp -r luci-app-mullvad root@192.168.1.1:/tmp/
ssh root@192.168.1.1 "cd /tmp/luci-app-mullvad && sh install.sh"
```

Uninstall with `sh install.sh remove`.

### C. Build with the OpenWrt SDK

Drop this directory into `feeds/luci/applications/` (or `package/`) and build
`luci-app-mullvad` as usual; the included `Makefile` uses `luci.mk`.

## First-time setup

Open **Services → Mullvad VPN → Settings**:

- **Option A**: enter your 16-digit account number and press
  *Register & create tunnel*. This registers the router as a new device on
  your account (counts toward the 5-device limit; remove old devices at
  mullvad.net/account if you're at the limit). The account number is used for
  the one registration call and is not stored on the router.
- **Option B**: paste a WireGuard `.conf` from
  https://mullvad.net/account/wireguard-config and press *Import & create tunnel*.

Both paths create: a WireGuard interface (default name `mullvad`, MTU 1420,
in-tunnel DNS `10.64.0.1`), the Mullvad peer, a firewall zone with
masquerading + MTU fix, and a LAN → mullvad forwarding — the same layout as
Mullvad's official OpenWrt guide.

Then pick your relay on the **Overview** tab.

If you already have a working Mullvad WireGuard interface, skip setup; the app
auto-detects it (or select it under Settings → Managed WireGuard interface).

## Notes

- **Kill switch**: this app adds LAN → mullvad forwarding but does not remove
  your existing LAN → wan forwarding. If you want traffic to hard-fail rather
  than leak when the tunnel is down, delete the LAN → wan forwarding under
  Network → Firewall.
- **Failover + manual choice**: the watchdog only acts when the tunnel is
  actually dead (in-tunnel gateway unreachable), so it won't fight your
  manually selected relay while the tunnel works.
- **Logs**: `logread -e mullvad-watchdog`
- **Backend test from SSH**:
  `ubus call luci.mullvad relays '{"refresh":true}' | head -c 300`

## Troubleshooting the relay download

The error shown in the UI includes the output of each fetch tool tried. Most
common causes:

- TLS errors → `opkg install ca-bundle libustream-mbedtls` (or `-openssl`)
  and check the system clock (`date`).
- DNS errors → the router itself has no working DNS (Network → DHCP and DNS).
- After a fresh install the menu item is missing → clear the LuCI cache:
  `rm -f /tmp/luci-indexcache*; /etc/init.d/rpcd restart` and re-login.
