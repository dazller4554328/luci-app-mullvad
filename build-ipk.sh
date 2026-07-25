#!/bin/sh
# Builds a ready-to-install .ipk from this directory without the OpenWrt SDK.
# The ipk is architecture-independent (scripts + JS only).
# Usage: ./build-ipk.sh   ->  dist/luci-app-mullvad_<version>_all.ipk
set -eu

PKG=luci-app-mullvad
VERSION=1.0.1
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/dist"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT" "$WORK/data" "$WORK/control"

# --- data ---
cp -a "$HERE/root/." "$WORK/data/"
mkdir -p "$WORK/data/www"
cp -a "$HERE/htdocs/." "$WORK/data/www/"

chmod 755 "$WORK/data/usr/libexec/rpcd/luci.mullvad" \
          "$WORK/data/usr/libexec/mullvad/watchdog.sh" \
          "$WORK/data/usr/libexec/mullvad/pick-relay.uc" \
          "$WORK/data/etc/init.d/mullvad-watchdog"

INSTALLED_SIZE=$(du -sk "$WORK/data" | cut -f1)

# --- control ---
cat > "$WORK/control/control" <<EOF
Package: $PKG
Version: $VERSION
Depends: libc, luci-base, luci-proto-wireguard, wireguard-tools
Section: luci
Architecture: all
Installed-Size: ${INSTALLED_SIZE}
Description:  LuCI app for Mullvad VPN: relay browser with latency probing,
  one-field account setup, connection checks and automatic relay failover.
EOF

cat > "$WORK/control/conffiles" <<EOF
/etc/config/mullvad
EOF

cat > "$WORK/control/postinst" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache
	/etc/init.d/rpcd restart
	/etc/init.d/mullvad-watchdog enable
	/etc/init.d/mullvad-watchdog start
}
exit 0
EOF

cat > "$WORK/control/prerm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	/etc/init.d/mullvad-watchdog stop 2>/dev/null
	/etc/init.d/mullvad-watchdog disable 2>/dev/null
}
exit 0
EOF

cat > "$WORK/control/postrm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache
	/etc/init.d/rpcd restart
}
exit 0
EOF

chmod 755 "$WORK/control/postinst" "$WORK/control/prerm" "$WORK/control/postrm"

# --- assemble (opkg ipk = gzipped tar of debian-binary + control/data tarballs) ---
echo "2.0" > "$WORK/debian-binary"

TARFLAGS="--owner=0 --group=0 --numeric-owner"

( cd "$WORK/control" && tar $TARFLAGS -czf "$WORK/control.tar.gz" ./ )
( cd "$WORK/data"    && tar $TARFLAGS -czf "$WORK/data.tar.gz" ./ )
( cd "$WORK" && tar $TARFLAGS -czf "$OUT/${PKG}_${VERSION}_all.ipk" \
	./debian-binary ./control.tar.gz ./data.tar.gz )

echo "Built: $OUT/${PKG}_${VERSION}_all.ipk"
