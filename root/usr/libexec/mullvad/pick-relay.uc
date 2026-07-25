#!/usr/bin/ucode
'use strict';

// Failover relay picker for mullvad-watchdog.
//
// Usage: ucode pick-relay.uc <current_pubkey> <scope>
//   scope: city | country | any
//
// Reads the cached relay list, finds candidates in the requested scope
// (excluding the current relay and drained relays with weight 0), and prints
// "hostname pubkey ipv4" for the next candidate in round-robin order.
// Prints nothing and exits non-zero when no candidate is available.

import { readfile, writefile } from 'fs';

const CACHE_FILES = [ '/tmp/mullvad/relays.json', '/etc/mullvad/relays.json' ];
const RR_FILE = '/tmp/mullvad/failover_rr';

const current_pubkey = ARGV[0] ?? '';
const scope = ARGV[1] ?? 'city';

let data = null;

for (let file in CACHE_FILES) {
	const raw = readfile(file);
	if (!raw)
		continue;

	try {
		const parsed = json(raw);
		if (type(parsed) == 'object' && length(parsed.relays)) {
			data = parsed;
			break;
		}
	}
	catch (e) {
		continue;
	}
}

if (!data)
	exit(1);

let current = null;

for (let r in data.relays) {
	if (r.pubkey == current_pubkey) {
		current = r;
		break;
	}
}

function in_scope(relay) {
	if (relay.pubkey == current_pubkey || !relay.ipv4 || relay.weight < 1)
		return false;
	if (!current || scope == 'any')
		return true;
	if (scope == 'city')
		return relay.location == current.location;
	return relay.country == current.country;
}

let candidates = filter(data.relays, in_scope);

// Widen the scope automatically when the preferred one is empty.
if (!length(candidates) && current && scope == 'city')
	candidates = filter(data.relays, r =>
		r.pubkey != current_pubkey && r.ipv4 && r.weight > 0 && r.country == current.country);

if (!length(candidates))
	candidates = filter(data.relays, r =>
		r.pubkey != current_pubkey && r.ipv4 && r.weight > 0);

if (!length(candidates))
	exit(1);

const idx = (int(readfile(RR_FILE)) + 1) % length(candidates);
writefile(RR_FILE, sprintf('%d', idx));

const pick = candidates[idx];
printf('%s %s %s\n', pick.hostname, pick.pubkey, pick.ipv4);
