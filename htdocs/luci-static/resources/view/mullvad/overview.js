'use strict';
'require view';
'require ui';
'require uci';
'require rpc';
'require poll';
'require dom';

var callRelays = rpc.declare({
	object: 'luci.mullvad',
	method: 'relays',
	params: [ 'refresh', 'max_age' ]
});

var callStatus = rpc.declare({
	object: 'luci.mullvad',
	method: 'status',
	params: [ 'device' ]
});

var callCheck = rpc.declare({
	object: 'luci.mullvad',
	method: 'check',
	params: []
});

var callProbe = rpc.declare({
	object: 'luci.mullvad',
	method: 'probe',
	params: [ 'targets' ]
});

var HANDSHAKE_STALE_S = 180;
var PROBE_MAX = 12;

function getManagedInterface() {
	var name = uci.get('mullvad', 'config', 'interface');

	if (name && uci.get('network', name) &&
	    uci.get('network', name, 'proto') === 'wireguard')
		return name;

	var fallback = null;
	uci.sections('network', 'interface', function(s) {
		if (!fallback && s.proto === 'wireguard')
			fallback = s['.name'];
	});

	return fallback;
}

function getPeerSection(iface) {
	var peer = null;

	if (!iface)
		return null;

	uci.sections('network', 'wireguard_' + iface, function(s) {
		if (!peer)
			peer = s;
	});

	return peer;
}

function formatBytes(n) {
	return '%1024.2mB'.format(n || 0);
}

function formatAge(seconds) {
	if (seconds < 0)
		return '?';
	if (seconds < 90)
		return _('%d seconds ago').format(seconds);
	if (seconds < 5400)
		return _('%d minutes ago').format(Math.round(seconds / 60));
	if (seconds < 129600)
		return _('%d hours ago').format(Math.round(seconds / 3600));
	return _('%d days ago').format(Math.round(seconds / 86400));
}

function badge(ok, text) {
	return E('span', {
		'style': 'display:inline-block; padding:2px 10px; border-radius:10px; font-weight:bold; color:#fff; background:%s'
			.format(ok ? '#2e7d32' : '#c62828')
	}, text);
}

return view.extend({

	relayData: null,
	iface: null,
	peer: null,

	load: function() {
		var self = this;

		return Promise.all([ uci.load('mullvad'), uci.load('network') ]).then(function() {
			self.iface = getManagedInterface();
			self.peer = getPeerSection(self.iface);

			var ttl = parseInt(uci.get('mullvad', 'config', 'cache_ttl') || '86400', 10);

			return Promise.all([
				self.iface ? callStatus(self.iface).catch(function() { return { up: false }; })
				           : Promise.resolve({ up: false }),
				callRelays(false, ttl).catch(function(e) { return { error: e.message }; })
			]);
		});
	},

	findRelayByPubkey: function(pubkey) {
		var relays = (this.relayData && this.relayData.relays) || [];

		for (var i = 0; i < relays.length; i++)
			if (relays[i].pubkey === pubkey)
				return relays[i];

		return null;
	},

	renderStatus: function(status) {
		var peerCfg = this.peer;
		var peerLive = (status.peers && status.peers[0]) || null;
		var hsAge = (peerLive && peerLive.handshake > 0) ? (status.now - peerLive.handshake) : -1;
		var connected = !!(status.up && hsAge >= 0 && hsAge < HANDSHAKE_STALE_S);

		var relay = peerCfg ? this.findRelayByPubkey(peerCfg.public_key) : null;
		var relayLabel = relay
			? '%s — %s, %s'.format(relay.hostname, relay.city, relay.country)
			: ((peerCfg && peerCfg.description) || _('Unknown'));

		if (!this.iface)
			return E('div', { 'class': 'alert-message warning' },
				_('No WireGuard interface found. Use the Settings tab to set one up with your Mullvad account number.'));

		var rows = [
			[ _('Tunnel'),           badge(connected, connected ? _('Connected') : _('Not connected')) ],
			[ _('Interface'),        this.iface ],
			[ _('Relay'),            relayLabel ],
			[ _('Endpoint'),         (peerLive && peerLive.endpoint) ||
			                         (peerCfg ? '%s:%s'.format(peerCfg.endpoint_host || '?', peerCfg.endpoint_port || '?') : _('Not configured')) ],
			[ _('Latest handshake'), hsAge >= 0 ? formatAge(hsAge) : _('Never') ],
			[ _('Traffic (down / up)'), peerLive
				? '%s / %s'.format(formatBytes(peerLive.rx), formatBytes(peerLive.tx))
				: '-' ]
		];

		return E('table', { 'class': 'table' }, rows.map(function(row) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width:220px; font-weight:bold' }, row[0]),
				E('td', { 'class': 'td left' }, row[1])
			]);
		}));
	},

	pollStatus: function() {
		var self = this;

		if (!self.iface)
			return Promise.resolve();

		return callStatus(self.iface).then(function(status) {
			var node = document.getElementById('mullvad-status');
			if (node)
				dom.content(node, self.renderStatus(status));
		}).catch(function() {});
	},

	/* ---------- relay picker ---------- */

	uniqueCountries: function() {
		var seen = {}, out = [];

		((this.relayData && this.relayData.relays) || []).forEach(function(r) {
			if (!seen[r.country]) {
				seen[r.country] = true;
				out.push(r.country);
			}
		});

		return out;
	},

	citiesFor: function(country) {
		var seen = {}, out = [];

		((this.relayData && this.relayData.relays) || []).forEach(function(r) {
			if (r.country === country && !seen[r.city]) {
				seen[r.city] = true;
				out.push(r.city);
			}
		});

		return out;
	},

	relaysFor: function(country, city) {
		return ((this.relayData && this.relayData.relays) || []).filter(function(r) {
			return (!country || r.country === country) && (!city || r.city === city);
		});
	},

	rebuildSelect: function(select, entries, keepFirst) {
		while (select.options.length > (keepFirst ? 1 : 0))
			select.remove(keepFirst ? 1 : 0);

		entries.forEach(function(e) {
			select.appendChild(E('option', { 'value': e[0] }, e[1]));
		});
	},

	refreshCityAndRelay: function() {
		var country = document.getElementById('mullvad-country').value;
		var citySel = document.getElementById('mullvad-city');

		this.rebuildSelect(citySel, this.citiesFor(country).map(function(c) {
			return [ c, c ];
		}), true);

		this.refreshRelaySelect();
	},

	refreshRelaySelect: function() {
		var country = document.getElementById('mullvad-country').value;
		var city = document.getElementById('mullvad-city').value;
		var relaySel = document.getElementById('mullvad-relay');

		var entries = this.relaysFor(country, city).map(function(r) {
			var tag = r.owned ? _('Mullvad-owned') : r.provider;
			if (r.weight < 1)
				tag += ', ' + _('drained');
			return [ r.pubkey, '%s (%s)'.format(r.hostname, tag) ];
		});

		this.rebuildSelect(relaySel, entries, false);
	},

	applyRelay: function(relay, port) {
		var self = this;

		if (!self.peer) {
			ui.addNotification(null,
				E('p', _('No WireGuard peer section found for interface "%s". Set the tunnel up from the Settings tab first.').format(self.iface)),
				'error');
			return Promise.resolve();
		}

		return new Promise(function(resolve) {
			ui.showModal(_('Switch relay'), [
				E('p', _('Switch the tunnel to the following relay?')),
				E('ul', {}, [
					E('li', {}, [ E('strong', {}, _('Relay: ')), '%s — %s, %s'.format(relay.hostname, relay.city, relay.country) ]),
					E('li', {}, [ E('strong', {}, _('Endpoint: ')), '%s:%s'.format(relay.ipv4, port) ]),
					E('li', {}, [ E('strong', {}, _('Operator: ')), relay.owned ? _('Mullvad-owned') : relay.provider ])
				]),
				E('p', { 'class': 'text-muted' },
					_('The change is applied with connectivity rollback: if the router loses contact with LuCI, the previous configuration is restored automatically.')),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() { ui.hideModal(); resolve(); }
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-positive important',
						'click': function() {
							ui.hideModal();

							var sid = self.peer['.name'];
							uci.set('network', sid, 'public_key', relay.pubkey);
							uci.set('network', sid, 'endpoint_host', relay.ipv4);
							uci.set('network', sid, 'endpoint_port', String(port));
							uci.set('network', sid, 'description', relay.hostname);

							resolve(uci.save().then(function() {
								return ui.changes.apply(true);
							}).catch(function(e) {
								ui.addNotification(null, E('p', _('Failed to apply: %s').format(e.message)), 'error');
							}));
						}
					}, _('Switch'))
				])
			]);
		});
	},

	handleApplySelected: function() {
		var relaySel = document.getElementById('mullvad-relay');
		var relay = null;

		for (var i = 0; i < ((this.relayData && this.relayData.relays) || []).length; i++)
			if (this.relayData.relays[i].pubkey === relaySel.value)
				relay = this.relayData.relays[i];

		if (!relay) {
			ui.addNotification(null, E('p', _('Select a relay first.')), 'warning');
			return Promise.resolve();
		}

		return this.applyRelay(relay, this.selectedPort());
	},

	selectedPort: function() {
		var v = parseInt(document.getElementById('mullvad-port').value, 10);
		return (v >= 1 && v <= 65535) ? v : 51820;
	},

	/* Ping the strongest candidates in the current selection and rank them. */
	handleFindFastest: function() {
		var self = this;
		var country = document.getElementById('mullvad-country').value;
		var city = document.getElementById('mullvad-city').value;

		var candidates = self.relaysFor(country, city).filter(function(r) {
			return r.weight > 0 && r.ipv4;
		});

		if (!candidates.length) {
			ui.addNotification(null, E('p', _('No relays in the current selection.')), 'warning');
			return Promise.resolve();
		}

		// Highest-weight relays first; weight is Mullvad's own capacity signal
		// (0 = drained). Latency is then measured from this router.
		candidates.sort(function(a, b) { return b.weight - a.weight; });
		candidates = candidates.slice(0, PROBE_MAX);

		ui.showModal(_('Measuring latency'), [
			E('p', { 'class': 'spinning' },
				_('Pinging %d candidate relays from the router…').format(candidates.length))
		]);

		return callProbe(candidates.map(function(r) { return r.ipv4; })).then(function(res) {
			ui.hideModal();

			if (res.error) {
				ui.addNotification(null, E('p', res.error), 'error');
				return;
			}

			var ranked = candidates.map(function(r) {
				return { relay: r, rtt: res.results[r.ipv4] };
			}).sort(function(a, b) {
				if (a.rtt === null) return 1;
				if (b.rtt === null) return -1;
				return a.rtt - b.rtt;
			});

			var rows = ranked.map(function(entry) {
				var r = entry.relay;
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, r.hostname),
					E('td', { 'class': 'td left' }, '%s, %s'.format(r.city, r.country)),
					E('td', { 'class': 'td left' }, r.owned ? _('Mullvad-owned') : r.provider),
					E('td', { 'class': 'td right' }, entry.rtt === null ? _('unreachable') : '%.1f ms'.format(entry.rtt)),
					E('td', { 'class': 'td right' }, E('button', {
						'class': 'btn cbi-button-action',
						'disabled': entry.rtt === null ? 'disabled' : null,
						'click': function() {
							ui.hideModal();
							self.applyRelay(r, self.selectedPort());
						}
					}, _('Use')))
				]);
			});

			ui.showModal(_('Latency results'), [
				E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Relay')),
						E('th', { 'class': 'th' }, _('Location')),
						E('th', { 'class': 'th' }, _('Operator')),
						E('th', { 'class': 'th right' }, _('Avg RTT')),
						E('th', { 'class': 'th' }, '')
					])
				].concat(rows)),
				E('div', { 'class': 'right' },
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Probe failed: %s').format(e.message)), 'error');
		});
	},

	handleRefreshList: function(ev) {
		var self = this;
		var btn = ev.target;

		btn.classList.add('spinning');
		btn.disabled = true;

		return callRelays(true, 0).then(function(res) {
			btn.classList.remove('spinning');
			btn.disabled = false;

			if (res.error && !res.relays) {
				ui.addNotification(null, E('p', _('Could not download the relay list: %s').format(res.error)), 'error');
				return;
			}

			if (res.error)
				ui.addNotification(null,
					E('p', _('Download failed (%s) — showing the cached list instead.').format(res.error)), 'warning');
			else
				ui.addNotification(null,
					E('p', _('Relay list updated: %d relays.').format(res.relays.length)), 'info');

			self.relayData = res;

			var countrySel = document.getElementById('mullvad-country');
			if (!countrySel) {
				// First successful fetch after an error render - the picker
				// does not exist yet, so rebuild the whole view.
				window.location.reload();
				return;
			}
			var current = countrySel.value;

			self.rebuildSelect(countrySel, self.uniqueCountries().map(function(c) {
				return [ c, c ];
			}), true);
			countrySel.value = current;

			self.refreshCityAndRelay();
			self.updateListInfo();
		}).catch(function(e) {
			btn.classList.remove('spinning');
			btn.disabled = false;
			ui.addNotification(null, E('p', _('Could not download the relay list: %s').format(e.message)), 'error');
		});
	},

	handleCheck: function() {
		ui.showModal(_('Checking connection'), [
			E('p', { 'class': 'spinning' }, _('Asking am.i.mullvad.net (via the router)…'))
		]);

		return callCheck().then(function(res) {
			ui.hideModal();

			if (res.error) {
				ui.addNotification(null, E('p', _('Check failed: %s').format(res.error)), 'error');
				return;
			}

			var ok = !!res.mullvad_exit_ip;

			ui.showModal(_('Connection check'), [
				E('p', {}, badge(ok, ok ? _('Traffic exits through Mullvad') : _('NOT exiting through Mullvad'))),
				E('ul', {}, [
					E('li', {}, [ E('strong', {}, _('Public IP: ')), res.ip || '?' ]),
					E('li', {}, [ E('strong', {}, _('Exit relay: ')), res.mullvad_exit_ip_hostname || '-' ]),
					E('li', {}, [ E('strong', {}, _('Location: ')), '%s, %s'.format(res.city || '?', res.country || '?') ])
				]),
				E('div', { 'class': 'right' },
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Check failed: %s').format(e.message)), 'error');
		});
	},

	updateListInfo: function() {
		var node = document.getElementById('mullvad-list-info');
		if (!node || !this.relayData)
			return;

		var d = this.relayData;
		var text = d.relays
			? _('%d relays, list from %s').format(d.relays.length, formatAge(Math.floor(Date.now() / 1000) - (d.fetched_at || 0)))
			: _('No relay list available');

		if (d.stale)
			text += ' — ' + _('stale cache, refresh failed');

		dom.content(node, E('em', {}, text));
	},

	render: function(data) {
		var self = this;
		var status = data[0];

		self.relayData = data[1] || {};

		var currentRelay = self.peer ? self.findRelayByPubkey(self.peer.public_key) : null;
		var defaultPort = (self.peer && self.peer.endpoint_port) ||
			uci.get('mullvad', 'config', 'endpoint_port') || '51820';

		var pickerDisabled = !self.relayData.relays;

		var picker = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Relay selection')),
			self.relayData.error && !self.relayData.relays
				? E('div', { 'class': 'alert-message error' }, [
					E('strong', {}, _('Could not download the relay list: ')),
					self.relayData.error,
					E('br'), E('br'),
					E('button', { 'class': 'btn cbi-button-action', 'click': ui.createHandlerFn(self, 'handleRefreshList') }, _('Retry'))
				])
				: E('div', {}, [
					E('div', { 'style': 'display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end' }, [
						E('div', {}, [
							E('label', { 'style': 'display:block; font-weight:bold' }, _('Country')),
							E('select', {
								'id': 'mullvad-country', 'class': 'cbi-input-select',
								'change': ui.createHandlerFn(self, 'refreshCityAndRelay')
							}, [ E('option', { 'value': '' }, _('— all countries —')) ])
						]),
						E('div', {}, [
							E('label', { 'style': 'display:block; font-weight:bold' }, _('City')),
							E('select', {
								'id': 'mullvad-city', 'class': 'cbi-input-select',
								'change': ui.createHandlerFn(self, 'refreshRelaySelect')
							}, [ E('option', { 'value': '' }, _('— all cities —')) ])
						]),
						E('div', {}, [
							E('label', { 'style': 'display:block; font-weight:bold' }, _('Relay')),
							E('select', { 'id': 'mullvad-relay', 'class': 'cbi-input-select' })
						]),
						E('div', {}, [
							E('label', { 'style': 'display:block; font-weight:bold' }, _('Port')),
							E('input', {
								'id': 'mullvad-port', 'class': 'cbi-input-text',
								'type': 'number', 'min': '1', 'max': '65535',
								'style': 'width:90px', 'value': defaultPort
							})
						])
					]),
					E('div', { 'style': 'margin-top:12px' }, [
						E('button', {
							'class': 'btn cbi-button-positive important',
							'click': ui.createHandlerFn(self, 'handleApplySelected')
						}, _('Switch to selected relay')),
						' ',
						E('button', {
							'class': 'btn cbi-button-action',
							'click': ui.createHandlerFn(self, 'handleFindFastest')
						}, _('Find fastest relay')),
						' ',
						E('button', {
							'class': 'btn',
							'click': ui.createHandlerFn(self, 'handleRefreshList')
						}, _('Refresh list'))
					]),
					E('p', { 'id': 'mullvad-list-info', 'style': 'margin-top:8px' })
				])
		]);

		var node = E('div', {}, [
			E('h2', {}, _('Mullvad VPN')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Status')),
				E('div', { 'id': 'mullvad-status' }, self.renderStatus(status)),
				E('div', { 'style': 'margin-top:8px' },
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, 'handleCheck')
					}, _('Check Mullvad exit')))
			]),
			picker
		]);

		if (!pickerDisabled) {
			// Populate the cascading selects after the nodes exist in `node`.
			window.requestAnimationFrame(function() {
				var countrySel = document.getElementById('mullvad-country');
				if (!countrySel)
					return;

				self.rebuildSelect(countrySel, self.uniqueCountries().map(function(c) {
					return [ c, c ];
				}), true);

				if (currentRelay) {
					countrySel.value = currentRelay.country;
					self.refreshCityAndRelay();
					document.getElementById('mullvad-city').value = currentRelay.city;
					self.refreshRelaySelect();
					document.getElementById('mullvad-relay').value = currentRelay.pubkey;
				}
				else {
					self.refreshCityAndRelay();
				}

				self.updateListInfo();
			});
		}

		poll.add(L.bind(self.pollStatus, self), 5);

		return node;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
