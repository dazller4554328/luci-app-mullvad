'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require rpc';

var callSetup = rpc.declare({
	object: 'luci.mullvad',
	method: 'setup',
	params: [ 'account' ]
});

var callRelays = rpc.declare({
	object: 'luci.mullvad',
	method: 'relays',
	params: [ 'refresh', 'max_age' ]
});

function wireguardInterfaces() {
	var out = [];

	uci.sections('network', 'interface', function(s) {
		if (s.proto === 'wireguard')
			out.push(s['.name']);
	});

	return out;
}

function zoneCovering(iface) {
	var found = null;

	uci.sections('firewall', 'zone', function(s) {
		var nets = L.toArray(s.network);
		if (nets.indexOf(iface) !== -1)
			found = s.name || s['.name'];
	});

	return found;
}

/* Parse a wg-quick style [Interface]/[Peer] config as exported by Mullvad. */
function parseWgConf(text) {
	var section = null;
	var cfg = { addresses: [], dns: [], peer: { allowed: [] } };

	text.split('\n').forEach(function(line) {
		line = line.replace(/[#;].*$/, '').trim();
		if (!line)
			return;

		var m = line.match(/^\[(\w+)\]$/);
		if (m) {
			section = m[1].toLowerCase();
			return;
		}

		var kv = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
		if (!kv)
			return;

		var key = kv[1].toLowerCase(), val = kv[2].trim();

		if (section === 'interface') {
			if (key === 'privatekey')
				cfg.private_key = val;
			else if (key === 'address')
				cfg.addresses = cfg.addresses.concat(val.split(',').map(function(s) { return s.trim(); }));
			else if (key === 'dns')
				cfg.dns = cfg.dns.concat(val.split(',').map(function(s) { return s.trim(); }));
		}
		else if (section === 'peer') {
			if (key === 'publickey')
				cfg.peer.pubkey = val;
			else if (key === 'allowedips')
				cfg.peer.allowed = cfg.peer.allowed.concat(val.split(',').map(function(s) { return s.trim(); }));
			else if (key === 'endpoint') {
				var em = val.match(/^\[?([^\]]+?)\]?:(\d+)$/);
				if (em) {
					cfg.peer.host = em[1];
					cfg.peer.port = em[2];
				}
			}
		}
	});

	if (!cfg.private_key)
		return { error: _('No PrivateKey found in the pasted config.') };
	if (!cfg.addresses.length)
		return { error: _('No Address found in the pasted config.') };
	if (!cfg.peer.pubkey || !cfg.peer.host)
		return { error: _('No [Peer] PublicKey/Endpoint found in the pasted config.') };

	return cfg;
}

return view.extend({

	load: function() {
		return Promise.all([
			uci.load('mullvad'),
			uci.load('network'),
			uci.load('firewall')
		]);
	},

	/* Create interface + peer + firewall config from parsed tunnel data. */
	createTunnel: function(name, tunnel) {
		if (uci.get('network', name))
			return Promise.reject(new Error(
				_('A network interface named "%s" already exists. Remove it first (Network → Interfaces) or choose another name.').format(name)));

		uci.add('network', 'interface', name);
		uci.set('network', name, 'proto', 'wireguard');
		uci.set('network', name, 'private_key', tunnel.private_key);
		uci.set('network', name, 'addresses', tunnel.addresses);
		uci.set('network', name, 'mtu', '1420');

		if (tunnel.dns && tunnel.dns.length) {
			uci.set('network', name, 'dns', tunnel.dns);
			uci.set('network', name, 'peerdns', '0');
		}

		var peer = uci.add('network', 'wireguard_' + name);
		uci.set('network', peer, 'description', tunnel.peer.description || 'mullvad');
		uci.set('network', peer, 'public_key', tunnel.peer.pubkey);
		uci.set('network', peer, 'endpoint_host', tunnel.peer.host);
		uci.set('network', peer, 'endpoint_port', String(tunnel.peer.port || '51820'));
		uci.set('network', peer, 'allowed_ips', tunnel.peer.allowed && tunnel.peer.allowed.length
			? tunnel.peer.allowed : [ '0.0.0.0/0', '::/0' ]);
		uci.set('network', peer, 'route_allowed_ips', '1');

		if (!zoneCovering(name)) {
			var zone = uci.add('firewall', 'zone');
			uci.set('firewall', zone, 'name', 'mullvad');
			uci.set('firewall', zone, 'input', 'REJECT');
			uci.set('firewall', zone, 'output', 'ACCEPT');
			uci.set('firewall', zone, 'forward', 'REJECT');
			uci.set('firewall', zone, 'masq', '1');
			uci.set('firewall', zone, 'mtu_fix', '1');
			uci.set('firewall', zone, 'network', [ name ]);

			var fwd = uci.add('firewall', 'forwarding');
			uci.set('firewall', fwd, 'src', 'lan');
			uci.set('firewall', fwd, 'dest', 'mullvad');
		}

		uci.set('mullvad', 'config', 'interface', name);

		return uci.save();
	},

	confirmAndCreate: function(name, tunnel, sourceNote) {
		var self = this;

		return new Promise(function(resolve) {
			ui.showModal(_('Create Mullvad tunnel'), [
				E('p', {}, sourceNote),
				E('ul', {}, [
					E('li', {}, [ E('strong', {}, _('Interface: ')), name + ' (MTU 1420)' ]),
					E('li', {}, [ E('strong', {}, _('Addresses: ')), tunnel.addresses.join(', ') ]),
					E('li', {}, [ E('strong', {}, _('First relay: ')), '%s:%s'.format(tunnel.peer.host, tunnel.peer.port || '51820') ]),
					E('li', {}, [ E('strong', {}, _('Firewall: ')), zoneCovering(name)
						? _('existing zone reused')
						: _('new zone "mullvad" (masquerade, MTU fix) + LAN → mullvad forwarding') ])
				]),
				E('p', { 'class': 'alert-message warning' },
					_('Once applied, LAN traffic is routed through Mullvad. The change uses connectivity rollback, so if the router becomes unreachable the old configuration is restored automatically.')),
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
							resolve(self.createTunnel(name, tunnel).then(function() {
								return ui.changes.apply(true);
							}).catch(function(e) {
								ui.addNotification(null, E('p', e.message), 'error');
							}));
						}
					}, _('Create & apply'))
				])
			]);
		});
	},

	handleQuickSetup: function(ev) {
		var self = this;
		var account = (document.getElementById('mullvad-account').value || '').replace(/\s+/g, '');
		var name = (document.getElementById('mullvad-newiface').value || 'mullvad').trim();

		if (!/^[0-9]{10,19}$/.test(account)) {
			ui.addNotification(null, E('p', _('Enter your numeric Mullvad account number (16 digits).')), 'warning');
			return Promise.resolve();
		}

		if (!/^[a-zA-Z0-9_]{1,12}$/.test(name)) {
			ui.addNotification(null, E('p', _('Interface name must be 1-12 letters, digits or underscores.')), 'warning');
			return Promise.resolve();
		}

		ui.showModal(_('Registering with Mullvad'), [
			E('p', { 'class': 'spinning' }, _('Generating a WireGuard key on the router and registering it with your Mullvad account…'))
		]);

		return Promise.all([
			callSetup(account),
			callRelays(false, 86400).catch(function() { return {}; })
		]).then(function(results) {
			ui.hideModal();

			var reg = results[0];
			var relayList = (results[1] && results[1].relays) || [];

			if (reg.error) {
				ui.addNotification(null, E('p', reg.error), 'error');
				return;
			}

			// Initial relay: strongest Mullvad-owned relay; the user picks a
			// proper one on the Overview page afterwards.
			var initial = null;
			relayList.forEach(function(r) {
				if (r.weight > 0 && (!initial || (r.owned && !initial.owned) ||
				    (r.owned === initial.owned && r.weight > initial.weight)))
					initial = r;
			});

			if (!initial) {
				ui.addNotification(null,
					E('p', _('Device registered, but the relay list could not be downloaded — cannot pick a first relay. Fix connectivity and retry.')), 'error');
				return;
			}

			var addresses = [ reg.ipv4 ];
			if (reg.ipv6)
				addresses.push(reg.ipv6);

			var tunnel = {
				private_key: reg.private_key,
				addresses: addresses,
				dns: [ uci.get('mullvad', 'config', 'gateway') || '10.64.0.1' ],
				peer: {
					description: initial.hostname,
					pubkey: initial.pubkey,
					host: initial.ipv4,
					port: uci.get('mullvad', 'config', 'endpoint_port') || '51820'
				}
			};

			var note = reg.device_name
				? _('Registered as device "%s". This creates the following configuration:').format(reg.device_name)
				: _('Device registered with Mullvad. This creates the following configuration:');

			return self.confirmAndCreate(name, tunnel, note);
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Setup failed: %s').format(e.message)), 'error');
		});
	},

	handleImport: function() {
		var self = this;
		var text = document.getElementById('mullvad-conf').value || '';
		var name = (document.getElementById('mullvad-newiface').value || 'mullvad').trim();

		if (!/^[a-zA-Z0-9_]{1,12}$/.test(name)) {
			ui.addNotification(null, E('p', _('Interface name must be 1-12 letters, digits or underscores.')), 'warning');
			return Promise.resolve();
		}

		var cfg = parseWgConf(text);
		if (cfg.error) {
			ui.addNotification(null, E('p', cfg.error), 'warning');
			return Promise.resolve();
		}

		cfg.peer.description = 'mullvad-imported';

		return self.confirmAndCreate(name, cfg,
			_('Parsed the pasted WireGuard config. This creates the following configuration:'));
	},

	render: function() {
		var self = this;
		var m, s, o;

		m = new form.Map('mullvad', _('Mullvad VPN — Settings'));

		s = m.section(form.NamedSection, 'config', 'mullvad', _('General'));

		o = s.option(form.ListValue, 'interface', _('Managed WireGuard interface'),
			_('The interface whose peer this app controls.'));
		var ifaces = wireguardInterfaces();
		var configured = uci.get('mullvad', 'config', 'interface');
		if (configured && ifaces.indexOf(configured) === -1)
			ifaces.push(configured);
		if (!ifaces.length)
			o.value('', _('— no WireGuard interface found —'));
		ifaces.forEach(function(name) { o.value(name, name); });

		o = s.option(form.Value, 'endpoint_port', _('Default endpoint port'),
			_('Mullvad WireGuard relays accept ports 53, 123, 4000–33433, 33565–51820 and 52001–60000.'));
		o.datatype = 'port';
		o.placeholder = '51820';

		o = s.option(form.Value, 'cache_ttl', _('Relay list cache lifetime (seconds)'));
		o.datatype = 'uinteger';
		o.placeholder = '86400';

		s = m.section(form.NamedSection, 'config', 'mullvad', _('Automatic failover'));

		o = s.option(form.Flag, 'failover', _('Enable failover watchdog'),
			_('Pings the in-tunnel Mullvad gateway; after three consecutive failures the tunnel is switched to another relay automatically.'));
		o.rmempty = false;

		o = s.option(form.Value, 'failover_interval', _('Check interval (seconds)'));
		o.datatype = 'min(10)';
		o.placeholder = '30';
		o.depends('failover', '1');

		o = s.option(form.ListValue, 'failover_scope', _('Failover candidates'),
			_('Where replacement relays are picked from. Falls back to a wider scope automatically when the preferred one has no candidates.'));
		o.value('city', _('Same city'));
		o.value('country', _('Same country'));
		o.value('any', _('Anywhere'));
		o.depends('failover', '1');

		return m.render().then(function(rendered) {
			var setupCard = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Set up a new tunnel')),
				E('p', {}, _('No WireGuard configuration yet? Either register this router directly with your account number, or paste a WireGuard config file downloaded from mullvad.net.')),

				E('div', { 'style': 'margin-bottom:10px' }, [
					E('label', { 'style': 'font-weight:bold; display:block' }, _('New interface name')),
					E('input', {
						'id': 'mullvad-newiface', 'class': 'cbi-input-text',
						'type': 'text', 'value': 'mullvad', 'style': 'width:160px'
					})
				]),

				E('div', { 'style': 'display:flex; flex-wrap:wrap; gap:24px' }, [
					E('div', { 'style': 'flex:1; min-width:280px' }, [
						E('h4', {}, _('Option A — account number')),
						E('p', { 'class': 'text-muted' },
							_('A WireGuard key is generated on the router and registered as a new device on your account (counts towards the 5-device limit). Your account number is used once and not stored.')),
						E('input', {
							'id': 'mullvad-account', 'class': 'cbi-input-text',
							'type': 'text', 'placeholder': '1234 5678 9012 3456',
							'style': 'width:240px'
						}),
						E('div', { 'style': 'margin-top:8px' },
							E('button', {
								'class': 'btn cbi-button-positive important',
								'click': ui.createHandlerFn(self, 'handleQuickSetup')
							}, _('Register & create tunnel')))
					]),
					E('div', { 'style': 'flex:1; min-width:280px' }, [
						E('h4', {}, _('Option B — paste a config file')),
						E('p', { 'class': 'text-muted' },
							_('Paste the contents of a .conf file from the Mullvad WireGuard configuration generator.')),
						E('textarea', {
							'id': 'mullvad-conf', 'class': 'cbi-input-textarea',
							'style': 'width:100%; min-height:140px; font-family:monospace',
							'placeholder': '[Interface]\nPrivateKey = …\nAddress = 10.x.y.z/32\nDNS = 10.64.0.1\n\n[Peer]\nPublicKey = …\nAllowedIPs = 0.0.0.0/0,::0/0\nEndpoint = 185.213.x.y:51820'
						}),
						E('div', { 'style': 'margin-top:8px' },
							E('button', {
								'class': 'btn cbi-button-action',
								'click': ui.createHandlerFn(self, 'handleImport')
							}, _('Import & create tunnel')))
					])
				])
			]);

			rendered.appendChild(setupCard);
			return rendered;
		});
	}
});
