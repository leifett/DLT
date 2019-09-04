const util = require('util');
const BlockIo = require('block_io');
const env = process.env;

const API = {
	main: {
		btc: env.BLOCKIO_BTC_MAIN,
		ltc: env.BLOCKIO_LTC_MAIN,
		dge: env.BLOCKIO_DGE_MAIN
	},
	test: {
		btc: env.BLOCKIO_BTC_TEST,
		ltc: env.BLOCKIO_LTC_TEST,
		dge: env.BLOCKIO_DGE_TEST
	},
	local: {
		btc: env.BLOCKIO_BTC_TEST,
		ltc: env.BLOCKIO_LTC_TEST,
		dge: env.BLOCKIO_DGE_TEST
	}
}

var self = module.exports = {
	native: API.main.keys().uc(),
	conn: {main: {}, test: {}, local: {}}, 
	opts: {net: 'main', asset: 'BTC'},
	init: (asset, net = 'main') => {
		if (asset.isObj) self.opts.assign(asset);
		net = self.opts.net;
		asset = self.opts.asset;

		asset = asset.lc();
		if (self.conn[net][asset])
			return self.conn[net][asset];

		var pin = process.env.BLOCKIO_PIN;
		if (!pin) throw new Error("No PIN provided for BlockIO");
		
		var c = new BlockIo(API[net][asset], pin, 2);
		c.get_new_address = util.promisify(c.get_new_address);
		c.get_address_balance = util.promisify(c.get_address_balance);
		return self.conn[net][asset] = c;
	},
	validateAddress: addr => {
		if (!addr.match(/^(1|3|bc1)/)) return false;
		if (addr.match(/[OIl0]/)) return false;
		if (addr.length < 26 || addr.length > 34) return false;
		return true;
	},
	getNewAddress: (asset) => {
		return self.init(asset).get_new_address({})
			.then(o => o.data.address);
	},
	getBal: async (asset, addr) => {
		return self.init(asset).get_address_balance({address: addr})
			.then(o => o.data.available_balance);
	},
	send: (asset, from, to, amt) => {
		return self.init(asset).withdraw_from_addresses({
			amounts: amt,
			from_addresses: from,
			to_addresses: to
		});
	}
} 