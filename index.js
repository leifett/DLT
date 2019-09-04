const jsp = require('js-prototype-lib');
jsp.install();

var DLT = module.exports = {};
'lib'.ls(/^[^.]/, {fullpath: true}).forEach(fn => {
	var o = require(fn);
	o.nm = fn.path('basename').lc();
	DLT[o.nm] = o;
})
