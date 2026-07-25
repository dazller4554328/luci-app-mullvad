#!/bin/sh
# Mullvad tunnel watchdog: monitors the WireGuard tunnel by pinging the
# in-tunnel gateway and rotates to another relay when the current one dies.
# Runs as a procd service (see /etc/init.d/mullvad-watchdog); it is a no-op
# unless uci mullvad.config.failover is set to 1.

STATE_DIR="/tmp/mullvad"
FAIL_FILE="$STATE_DIR/fail_count"
COOLDOWN_FILE="$STATE_DIR/last_failover"
PICKER="/usr/libexec/mullvad/pick-relay.uc"

log() {
	logger -t mullvad-watchdog "$*"
}

uci_get() {
	uci -q get "mullvad.config.$1"
}

find_peer_section() {
	# First peer section of type wireguard_<iface>
	uci -q show network | sed -n "s/^network\.\([^.=]*\)=wireguard_$1\$/\1/p" | head -n 1
}

rotate_relay() {
	iface="$1"
	peer="$2"

	current_pubkey="$(uci -q get "network.$peer.public_key")"
	scope="$(uci_get failover_scope)"
	scope="${scope:-city}"

	pick="$(ucode "$PICKER" "$current_pubkey" "$scope" 2>/dev/null)"
	if [ -z "$pick" ]; then
		# No relay cache yet (e.g. right after first boot) - populate it and
		# try again on the next cycle.
		log "no relay candidates available, refreshing relay cache"
		ubus call luci.mullvad relays '{"refresh": true}' >/dev/null 2>&1
		return 1
	fi

	hostname="${pick%% *}"
	rest="${pick#* }"
	pubkey="${rest%% *}"
	ipv4="${rest##* }"

	[ -n "$hostname" ] && [ -n "$pubkey" ] && [ -n "$ipv4" ] || return 1

	log "failing over from $(uci -q get "network.$peer.description") to $hostname ($ipv4)"

	uci set "network.$peer.public_key=$pubkey"
	uci set "network.$peer.endpoint_host=$ipv4"
	uci set "network.$peer.description=$hostname"
	uci commit network
	ifup "$iface"

	date +%s > "$COOLDOWN_FILE"
	return 0
}

mkdir -p "$STATE_DIR"
log "watchdog started"

while :; do
	interval="$(uci_get failover_interval)"
	case "$interval" in
		''|*[!0-9]*) interval=30 ;;
	esac
	[ "$interval" -ge 10 ] || interval=10

	sleep "$interval"

	[ "$(uci_get failover)" = "1" ] || continue

	iface="$(uci_get interface)"
	[ -n "$iface" ] || continue

	# Interface intentionally down (or not configured yet) - nothing to guard.
	wg show "$iface" >/dev/null 2>&1 || continue

	peer="$(find_peer_section "$iface")"
	[ -n "$peer" ] || continue

	gw="$(uci_get gateway)"
	gw="${gw:-10.64.0.1}"

	if ping -c 2 -W 2 -I "$iface" "$gw" >/dev/null 2>&1; then
		rm -f "$FAIL_FILE"
		continue
	fi

	fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
	echo "$fails" > "$FAIL_FILE"

	if [ "$fails" -lt 3 ]; then
		log "tunnel health check failed ($fails/3) on $iface"
		continue
	fi

	# Rate-limit rotations so a dead WAN uplink doesn't churn through relays.
	now="$(date +%s)"
	last="$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)"
	if [ $(( now - last )) -lt 120 ]; then
		continue
	fi

	rm -f "$FAIL_FILE"
	rotate_relay "$iface" "$peer"
done
