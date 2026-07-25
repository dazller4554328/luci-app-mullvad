#!/bin/sh
# Builds a .apk package for apk-based OpenWrt (post-24.10, e.g. 25.x).
# Requires apk-tools v3 (`apk mkpkg`); point APK at the binary if it is not
# in PATH. Usage: [APK=/path/to/apk] ./build-apk.sh
#   ->  dist/luci-app-mullvad-1.0.0-r1.apk
set -eu

PKG=luci-app-mullvad
VERSION=1.0.1-r1
APK=${APK:-apk}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/dist"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

command -v "$APK" >/dev/null 2>&1 || {
	echo "apk-tools v3 not found - set APK=/path/to/apk" >&2
	exit 1
}

mkdir -p "$OUT" "$WORK/data"

# --- data ---
cp -a "$HERE/root/." "$WORK/data/"
mkdir -p "$WORK/data/www"
cp -a "$HERE/htdocs/." "$WORK/data/www/"

chmod 755 "$WORK/data/usr/libexec/rpcd/luci.mullvad" \
          "$WORK/data/usr/libexec/mullvad/watchdog.sh" \
          "$WORK/data/usr/libexec/mullvad/pick-relay.uc" \
          "$WORK/data/etc/init.d/mullvad-watchdog"

# Normalize permissions; ownership is normalized to root below.
find "$WORK/data" -type d -exec chmod 755 {} +
find "$WORK/data" -type f ! -perm -u+x -exec chmod 644 {} +

# --- maintainer scripts ---
cat > "$WORK/post-install" <<'EOF'
#!/bin/sh
rm -f /tmp/luci-indexcache*
rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart
/etc/init.d/mullvad-watchdog enable
/etc/init.d/mullvad-watchdog start
exit 0
EOF

cat > "$WORK/pre-deinstall" <<'EOF'
#!/bin/sh
/etc/init.d/mullvad-watchdog stop 2>/dev/null
/etc/init.d/mullvad-watchdog disable 2>/dev/null
exit 0
EOF

cat > "$WORK/post-deinstall" <<'EOF'
#!/bin/sh
rm -f /tmp/luci-indexcache*
rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart
exit 0
EOF

# Package files must be recorded as root-owned; use fakeroot when building
# as a regular user.
if [ "$(id -u)" = 0 ]; then
	FAKEROOT=""
elif command -v fakeroot >/dev/null 2>&1; then
	FAKEROOT="fakeroot --"
else
	echo "WARNING: building as non-root without fakeroot - file ownership will be wrong" >&2
	FAKEROOT=""
fi

$FAKEROOT sh -c "chown -R 0:0 '$WORK/data' && '$APK' mkpkg \
	--info 'name:$PKG' \
	--info 'version:$VERSION' \
	--info 'description:LuCI app for Mullvad VPN: relay browser with latency probing, one-field account setup, connection checks and automatic relay failover' \
	--info 'arch:noarch' \
	--info 'license:MIT' \
	--info 'maintainer:dazller4554328' \
	--info 'tags:openwrt:section=luci' \
	--info 'url:https://github.com/dazller4554328/luci-app-mullvad' \
	--info 'depends:luci-base luci-proto-wireguard wireguard-tools' \
	--script 'post-install:$WORK/post-install' \
	--script 'pre-deinstall:$WORK/pre-deinstall' \
	--script 'post-deinstall:$WORK/post-deinstall' \
	--files '$WORK/data' \
	--output '$OUT/${PKG}-${VERSION}.apk'"

echo "Built: $OUT/${PKG}-${VERSION}.apk"
