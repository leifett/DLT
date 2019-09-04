"use strict"

const SLP = require('slp-sdk');
const utils = require('../dlt.utils');

const lang = 'english';
const Network = { 
    main: 'https://rest.bitcoin.com/v2/',
    test: 'https://trest.bitcoin.com/v2/',
    local: 'https://trest.bitcoin.com/v2/'
};

var self = module.exports = {
    conn: {}, 
    opts: {net: 'main'}, 
    cache: {},
    init: async (net = self.opts.net, mnemonic) => {
        if (net.isObj) {
            self.opts.assign(net);
            net = self.opts.net;
        }
        if (self.conn[net]) return self.conn[net];

        self.conn[net] = new SLP({restURL: Network[net]});
        var {crypto, wallet} = self.opts;
        if (!mnemonic && wallet) {
            mnemonic = await wallet.get()
            if (mnemonic) mnemonic = crypto.decrypt(mnemonic.PK);
            else {
                mnemonic = (await self.createWallet()).PK;
                await wallet.save(crypto.encrypt(mnemonic))
            }
        }
            
        if (mnemonic) await self.setWallet(mnemonic);
        return self.conn[net]
    },
    createWallet: async () => {
        var SLP = await self.init();
        const mnemonic = SLP.Mnemonic.generate(256, SLP.Mnemonic.wordLists()[lang])
        const PK = await self.setWallet(mnemonic);
        return {mnemonic, PK: PK.toString('hex')};
    },
    setWallet: async (mnemonic) => {
        var SLP = await self.init();
        var isPK = mnemonic.match(/[0-9a-f]+/) && mnemonic.length == 128;
        return self.cache.PK = isPK ? mnemonic : SLP.Mnemonic.toSeed(mnemonic);
    },
    setAccount: async () => {
        var SLP = await self.init();
        let PK = self.cache.PK;
        if (!PK) throw new Error('BCH: No wallet initialised');
        let masterHDNode = SLP.HDNode.fromSeed(PK, self.opts.net + 'net');
        return self.cache.account = SLP.HDNode.derivePath(masterHDNode, "m/44'/145'/0'");
    },
    getNewAddress: async (i) => {
        var SLP = await self.init();
        var acct = self.cache.account || await self.setAccount();
        if (typeof i == 'undefined') i = await self.opts.next();
        var HDNode = SLP.HDNode.derivePath(acct, '0/' + i);
        var bch = SLP.HDNode.toCashAddress(HDNode);
        var slp = SLP.Address.toSLPAddress(bch);
        return {HDNode, bch, slp};
    },
    getBal: async (asset, addr) => {
        var SLP = await self.init();
        if (asset.match(/^bch$/i)) {
            let d = await SLP.Address.details(addr);
            return d.balance;
        }
        // TODO: caller needs to provide either a token ID or
        // a symbol that can be disambiguated.  the code must then
        // iterate through the returned array looking for the
        // argument
        var symbol = asset.split(':')[1];
        var id = 0 // TODO: convert symbol to token id
        var bals = await SLP.Utils.balancesForAddress(addr);
        var token = bals.filter(o => o.tokenId == id);
        var err = token.length > 1 ? 'Multiple' : token.length == 0 ? 'No' : '';
        if (err) throw new Error(err + ' tokens with symbol ' + symbol + ' found!');
        return token[0].balance; // TODO: check to make sure balance isn't returned in satoshi
    },
    getAmt: async (amt, txid) => {
        var dec = 8;
        if (txid) {
            let info = await self.token.info(txid);
            dec = info.decimalCount;
        }
        return utils.bignum(amt, dec);
    },
    getFee: async () => {
        var SLP = await self.init();
        const byteCount = SLP.BitcoinCash.getByteCount(
            {P2PKH: 1}, {P2PKH: 2}
          );
        const satoshisPerByte = 1.0
        return Math.floor(satoshisPerByte * byteCount);
    },
    addr: {
        validate: (addr, err) => {
            var ret = true;
            if (addr.length != 64) ret = false;
            if (!addr.match(/[0-9a-f]+/i)) ret = false;
            if (!err) return ret;
            if (!ret) throw new Error(err);
        }    
    },
    token: {
        async ls() {
            var SLP = await self.init();
            if (!self.cache.tokens) {
                self.cache.tokens = {};
                let ls = await SLP.Utils.list();
                let r = (acc, o) => { acc[o.id] = o; return acc; }
                self.cache.tokens.id = ls.reduce(r, {});
                r = (acc, o) => { acc[o.symbol] = o; return acc; }
                self.cache.tokens.sym = ls.reduce(r, {});
            }
            return self.cache.tokens;
        },
        set(ls) {
			self.cache.tokens = ls;
		},
        async info(addr) {
            var ls = await this.ls();
            return ls.id[addr].assign({nm: self.nm, addr});
        },
        create: async (o) => {
            var SLP = await self.init();
    
            for (let k of 'symbol/decimals/name/uri'.split('/'))
                if (!o[k]) throw new Error('Cannot create token without ' + k);
            if (!Number.isInteger(o.decimals))
                throw new Error('Decimals must be an integer');
    
            var from = await self.getNewAddress(0);
            var t = {
                symbol: o.symbol,
                decimals: o.decimals,
                initialTokenQty: o.qty || 0,
                name: o.name,
                documentUri: o.uri,
                documentHash: null,
                fundingWif: SLP.HDNode.toWIF(from.HDNode),
                fundingAddress: from.bch,
                tokenReceiverAddress: from.slp,
                batonReceiverAddress: from.slp,
                bchChangeReceiverAddress: from.bch
            }
            return SLP.TokenType1.create(t);
        },
        mint: async (id, qty) => {
            var SLP = await self.init();
            
            if (typeof qty == 'string') qty = parseInt(qty);
            if (qty <= 0) throw new Error('Minting quantity must be an integer greater than zero');
            var from = await self.getNewAddress(0);
            var t = {
                fundingWif: SLP.HDNode.toWIF(from.HDNode),
                fundingAddress: from.bch,
                tokenReceiverAddress: from.slp,
                batonReceiverAddress: from.slp,
                bchChangeReceiverAddress: from.bch,
                tokenId: id,
                additionalTokenQty: qty
            }
            return SLP.TokenType1.mint(t);
        }
    },
    send: async (token, to, amt) => {
        var SLP = await self.init();
        var from = await self.getNewAddress(0);

        if (token != 'BCH') {
            var tx = {
                fundingAddress: from.slp,
                fundingWif: SLP.HDNode.toWIF(from.HDNode),
                tokenReceiverAddress: to,
                bchChangeReceiverAddress: from.slp,
                tokenId: token,
                // amount: amt
                amount: await self.getAmt(amt, token)
            };
            return SLP.TokenType1.send(tx);
        }
        else {
            // TODO: the current implementation needs re-engineering as it
            // generates a transaction for each UTXO it processes, which 
            // results in higher fees.  A better solution is to produce a
            // multi-input transaction but at present there's no time to
            // address this
            let remainder = await self.getAmt(amt);
            let fee = await self.getFee();

            let o = await SLP.Address.utxo(from.bch);
            o.utxos.sort((a,b) => a.amount < b.amount ? 1 : -1);
            var ret = [];
            for (var u of o.utxos) {
                if (remainder <= 0) break;
                const tb = new SLP.TransactionBuilder(self.opts.net + 'net');
                tb.addInput(u.txid, u.vout);
                if (remainder + fee >= u.satoshis) {
                    let amt = u.satoshis - fee;
                    tb.addOutput(to, amt);
                    remainder -= amt;
                }
                else {
                    tb.addOutput(to, remainder);
                    tb.addOutput(from.bch, u.satoshis - remainder - fee);
                    remainder = 0;
                }
                const keyPair = SLP.HDNode.toKeyPair(from.HDNode);
                tb.sign(
                    0, keyPair, null, tb.hashTypes.SIGHASH_ALL, u.satoshis
                );
                const tx = [tb.build().toHex()];
                ret.push(await SLP.RawTransactions.sendRawTransaction(tx));
            }
            return ret;
        }
    }
};
