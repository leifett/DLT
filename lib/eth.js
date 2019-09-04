const fetch = require('node-fetch');
const web3 = require('web3');
const Tx = require('ethereumjs-tx').Transaction;
const utils = require('../dlt.utils');

const Network = {
	MAINNET: 1,
	MORDEN: 2,
	ROPSTEN: 3,
	RINKEBY: 4,
	UBIQ: 8,
	KOVAN: 42,
	SOKOL: 77
};

const API = {
	main: 'https://mainnet.infura.io/',
	test: 'https://ropsten.infura.io/',
	local: 'https://ropsten.infura.io/'
};
var conn = {};

var self = module.exports = {
	opts: {net: 'main'},
	cache: {},
	init: (net) => {
		if (net.isObj) {
			self.opts.assign(net);
			net = self.opts.net;
		}
		if (conn[net]) return conn[net];

		let p = new web3.providers.HttpProvider(API[net]); 
		return conn[net] = new web3(p);
	},
	getNewAddress: () => {
        let web3 = self.init();
		let {address, privateKey} = web3.eth.accounts.create();
		var ret = Promise.resolve({address, key: privateKey});
		if (self.opts.crypto) ret = ret.then(addr => {
			addr.key = self.crypto.encrypt(addr.key);
			return addr;
		});
		return ret;
	},
	getBal: async (asset, addr) => {
		let web3 = self.init(); 
		if (self.opts.crypto)
			addr.key = self.opts.crypto.decrypt(addr.key);

		let isToken = asset.split(':')[1];
		if (!isToken) {
			return web3.eth.getBalance(addr.address)
				.then(bal => web3.utils.fromWei(bal));
			}
		else {
			let c = self.Contracts[asset.toUpperCase()];
			if (!c) throw new Error('TOKEN_NO_DEF');
			c = new web3.eth.Contract(c.ABI, c.address);
			return c.methods.balanceOf(addr.address).call()
				.then(o => web3.utils.fromWei(o.balance));
		}
	},
	addr: {
		validate: (addr, err) => {
			var ret = true;
			if (addr.length != 42) ret = false;
			if (!addr.match(/0x[0-9a-f]+/i)) ret = false;
			if (!err) return ret;
			if (!ret) throw new Error(err);
		}	
	},
	token: {
		async info(addr) {
			var ABI = await self.getABI(addr);
			var sym = await self.getSymbol(addr, ABI);
			return {dlt: self.nm, addr, sym, ABI};
		},
		set(ls) {
			self.cache.tokens = ls;
		}
	},
	getABI: async (addr, stage = 'main') => {
		const net = {'main': 'api', 'test': 'ropsten'};
		const base = 'etherscan.io/api?module=contract&action=getabi&address=';
	
		var url = 'http://' + net[stage] + '.' + base + addr;
		return fetch(url).then(res => res.json())
			.then(js => {
				if (js.message == 'NOTOK')
					throw new Error('Etherscan: ' + js.result);
				return JSON.parse(js.result)
			});
	},
	getSymbol: async (addr, ABI) => {
		if (!ABI) ABI = await self.getABI(addr);
		return self.getContract(addr, ABI).methods.symbol().call();
	},
	getAccount: (key) => {
		let web3 = self.init();
		return web3.eth.accounts.privateKeyToAccount(key);
	},
	getAmt: async (c, amt) => {
		var web3 = self.init();
		if (typeof amt == 'number') {
			console.log('WARNING: getAmt() passed numerical value.  Should be string');
			amt = amt.toString();
		}
		var dec = await c.methods.decimals().call();
		return web3.utils.toBN(utils.bignum(amt, dec));
	},
	getContract(addr, ABI, opts) {
		return self.init().eth.Contract(ABI, addr, opts);
    },
    getGasPrice: (level = 'safeLow') => {
        let ethgas = 'https://ethgasstation.info/json/ethgasAPI.json';
        return fetch(ethgas).then(res => res.json())
            .then(o => o[level] * 1e8); // returned in wei
    },
	send: async (token, from, toAddr, amt) => {
		var web3 = self.init();
		var crypto = self.opts.crypto;
		if (crypto) from.key = crypto.decrypt(from.key);
		var tx = {
			nonce: await web3.eth.getTransactionCount(from.address, 'pending'),
			gasPrice: await web3.eth.getGasPrice() * 1.25,
			chainId: self.opts.net == 'main' ? Network.MAINNET : Network.ROPSTEN
		};
		if (token == 'ETH') {
			if (typeof amt == 'number') amt = amt.toString();
			tx = Object.assign(tx, {
				to: toAddr,	
				value: web3.utils.toHex(web3.utils.toWei(amt, 'ether'))
			});
		}
		else {
			let ci = self.cache.tokens[token];
			let c = self.getContract(ci.address, ci.ABI, {from: from.address});
			let txamt = (await self.getAmt(c, amt)).toString();
			tx = Object.assign(tx, {
				to: ci.address,
				data: c.methods.transfer(toAddr, txamt).encodeABI(),
			});
		}
		tx.gasLimit = await web3.eth.estimateGas(tx);
		tx = new Tx(tx);
        tx.sign(Buffer.from(from.key, 'hex'));
        let stx = '0x' + tx.serialize().toString('hex');
		var ret = await web3.eth.sendSignedTransaction(stx);
		return ret.transactionHash;
	}
}
