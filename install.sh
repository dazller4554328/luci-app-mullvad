#!/bin/sh
# Manual installer - run ON THE ROUTER from inside this directory.
# For opkg systems, prefer the .ipk from dist/ instead. This script exists for
# apk-based OpenWrt builds (post-24.10) and for development installs.
# Usage: ./install.sh          install/upgrade
#        ./install.sh remove   uninstall
set -eu

[ -f /etc/openwrt_release ] || {
	echo "This script must run on the OpenWrt router." >&2
	exit 1
}

HERE=$(cd "$(dirname "$0")" && pwd)

remove() {
	/etc/init.d/mullvad-watchdog stop 2>/dev/null || true
	/etc/init.d/mullvad-watchdog disable 2>/dev/null || true
	rm -f /usr/libexec/rpcd/luci.mullvad \
	      /etc/init.d/mullvad-watchdog \
	      /usr/share/luci/menu.d/luci-app-mullvad.json \
	      /usr/share/rpcd/acl.d/luci-app-mullvad.json
	rm -rf /usr/libexec/mullvad \
	       /www/luci-static/resources/view/mullvad \
	       /tmp/mullvad /etc/mullvad
	echo "Left /etc/config/mullvad in place (delete manually if wanted)."
	post
	echo "Removed."
}

post() {
	rm -f /tmp/luci-indexcache* 2>/dev/null || true
	rm -rf /tmp/luci-modulecache 2>/dev/null || true
	/etc/init.d/rpcd restart
	/etc/init.d/uhttpd restart 2>/dev/null || true
}

if [ "${1:-}" = "remove" ]; then
	remove
	exit 0
fi

# Keep an existing config file
CFG_BACKUP=""
if [ -f /etc/config/mullvad ]; then
	CFG_BACKUP=$(mktemp)
	cp /etc/config/mullvad "$CFG_BACKUP"
fi

cp -a "$HERE/root/." /
mkdir -p /www
cp -a "$HERE/htdocs/." /www/

if [ -n "$CFG_BACKUP" ]; then
	cp "$CFG_BACKUP" /etc/config/mullvad
	rm -f "$CFG_BACKUP"
	echo "Kept existing /etc/config/mullvad."
fi

chmod 755 /usr/libexec/rpcd/luci.mullvad \
          /usr/libexec/mullvad/watchdog.sh \
          /usr/libexec/mullvad/pick-relay.uc \
          /etc/init.d/mullvad-watchdog

post
/etc/init.d/mullvad-watchdog enable
/etc/init.d/mullvad-watchdog restart

echo "Installed. Open LuCI -> Services -> Mullvad VPN."
