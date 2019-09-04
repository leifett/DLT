const fetch = require('node-fetch');
const {Api, JsonRpc} = require('eosjs');
const {JsSignatureProvider} = require('eosjs/dist/eosjs-jssig');  // development only
const {createDfuseClient, InboundMessageType, FileApiTokenStore} = require("@dfuse/client");
const {TextEncoder, TextDecoder} = require('util');
const utils = require('../dlt.utils');
const env = process.env;

global.fetch = fetch;
global.WebSocket = require('ws');

const ACCT = env.EOS_ACCT;
const PK = env.EOS_PK;
const TOKEN = env.DFUSE_IO_API_KEY;
if (!ACCT) throw new Error('No EOS account specified!')
if (!PK) throw new Error('No EOS private key available')
if (!TOKEN) throw new Error('No DFuse API token!');

const Network = { 
    main: 'mainnet.eos.dfuse.io',
    test: 'kylin.eos.dfuse.io',
    local: '127.0.0.1:8888'
};
 
var self = module.exports = {
    MT: InboundMessageType,
    cache: {conn: {}},
    opts: {net: 'main'},
    init: async (net = self.opts.net) => {
        if (net.isObj) self.opts.assign(net);
        net = self.opts.net;
        if (self.cache.conn[net]) 
            return self.cache.conn[net];

        var ws = createDfuseClient({
            apiKey: TOKEN, network: Network[net],
            apiTokenStore: new FileApiTokenStore('/tmp/dfuse-token.json'),
        });

        const rpc = new JsonRpc('http://' + Network[net], {fetch});
        const signatureProvider = new JsSignatureProvider([PK]);
        const api = new Api({
            rpc, signatureProvider, 
            textDecoder: new TextDecoder(), 
            textEncoder: new TextEncoder()
        });

        return self.cache.conn[net] = {ws, rpc, api};
    },
    exec: async (name, data = {}, opts = {}) => {
        var eos = await self.init(opts);
        var auth = typeof opts == 'string' ? auth : opts.auth;
        var authorization = [{
            actor: auth || ACCT,
            permission: 'active'
        }]
        try {
            var action = { account: ACCT, name, authorization, data }
            var opts = {blocksBehind: 3, expireSeconds: 30}
            return await eos.api.transact(
                {actions: [action]}, opts
            )
        }
        catch(e) {
            var preamble = 'assertion failure with message: ';
            if (e.message.indexOf(preamble) > -1)
                e.message = e.message.replace(preamble, '');
            e.action = action;
            throw e;
        }
    },
    table: async (table, opts = {}) => {
        var eos = await self.init(opts);
        var r, next = 0, ret = [];
        do {
            r = await eos.rpc.get_table_rows({
                table,
                code: opts.code || ACCT, 
                scope: opts.scope || ACCT,
                limit: opts.limit || 100,
                lower_bound: next,
                json: true
            });
            let rows = r.rows;
            if (rows.length == 0) continue;
            next = rows[rows.length - 1].id + 1;
            if (opts.filter) rows = rows.filter(opts.filter);
            ret = ret.concat(rows);
        } while (r.more);
        return ret;
    },
    getAmt: async (amt, asset) => {
        var dec = 8;
        if (asset) {
            if (typeof asset == 'number') dec = asset;
            else {
                let info = await self.token.info(asset);
                dec = info.precision;
            }
        }
        return utils.bignum(amt, dec);
    },
    watch: async (account, cb, action = 'transfer', opts = {}) => {
        try {
            var eos = await self.init(opts);
            eos.ws.streamActionTraces(
                {account, action_name: action}, 
                m => {
                    if (m.type != self.MT.ACTION_TRACE) return;
                    const {to, quantity, memo} = message.data.trace.act.data;
                    if (to == eos.acct) cb(quantity, memo);
                }
            );
        }
        catch (e) {
            console.log('-- eos.js watch ---')
            console.log(e.error)
        }
    },
    send: async (asset, to, amt, memo, opts = {}) => {
        var eos = await self.init(opts);
        if (asset == 'EOS') asset = 'eosio.token:EOS';

        var {contract, symbol, precision} = self.token.info(asset);
        var authorization = [{
            actor: ACCT,
            permission: "active"
        }];
        var actions = [{
            account: contract, name: "transfer",
            authorization,
            data: {
                from: ACCT, to, memo,
                quantity: self.getAmt(amt, precision) + ' ' + symbol
            }
        }];
        return eos.api.transact({actions}, {
            blocksBehind: 3,
            expireSeconds: 30
        });
    },
    addr: {
        validate: (addr, err) => {
            var ret = true;
            if (addr.length != 12) ret = false;
            if (!addr.match(/^[a-z]/)) ret = false;
            if (!addr.match(/[a-z1-5.]+/i)) ret = false;
            if (!err) return ret;
            if (!ret) throw new Error(err);
        }    
    },
    token: {
        ls: async (issuer, opts = {}) => {
            if (issuer.isObj) {
                opts = issuer; issuer = null;
            }
            var t = await self.table('treasury', opts.concat({limit: 1000}));
            if (issuer) t = t.filter(o => o.issuer_acct == issuer);
            return t;
        },
        create: (o, opts) => {
            return self.exec('create', o, opts);
        },
        mint: async (cust, qty, sym, DVPU, opts = {}) => {
            var t = await self.token.ls(opts);
            var td = t.filter(o => o.supply.indexOf(sym) > -1)[0]; // token definition
            qty = formatBySym(qty, td);
            return self.exec('mint', {cust, qty, DVPU}, opts);

            function formatBySym(qty, td) {
                var [q, sym] = td.supply.split(/\s+/);
                if (q.indexOf('.') == -1) return Math.floor(qty) + ' ' + sym;
                var dec = q.split('.')[1].length;
                var [i, d] = qty.toString().split('.');
                qty = i + '.' + (d || '').substr(0, dec).padEnd(dec, '0');
                return qty + ' ' + sym;
            }
        },
        audit: async (acct, qty) => {
            return self.exec('supplyaudit', {acct, qty, type: 'A'});
        },
        burn: (id, DVPU, opts) => {
            return self.exec('burn', {id, DVPU}, opts);
        },
        info: async (asset) => {
            if (!self.cache.tokens) {
                var ls = await fetch('https://api.newdex.io/v1/common/symbols');
                if (ls.code != 200)
                    throw new Error('Newdex fetch code: ' + ls.code);

                var r = (acc, o) => {
                    var {contract, currency, currency_precision} = o;
                    acc[contract + ':' + currency] = {
                        contract, symbol: currency, precision: currency_precision
                    }; 
                    return acc; 
                };
                self.cache.tokens = ls.data.reduce(r, {});
            }
            return self.cache.tokens[asset];
        },
    },
    isValid: {
        acct(s) {
            if (self.opts.net == 'local') return true;
            return !!s.match(/^[a-z1-5.]{12}$/);
        }
    }
}