/**
 * $ajax simulates some behaviour of jQuery.ajax() as used by the GMA API.
 *
 */

var request = require('request');
var $ = require('node-jquery');

var $ajax = function (args) {
    var dfd = $.Deferred();

    // Map jQuery.ajax() args into request() equivalents
    var method = args.method || args.type;
    var body, qs, form;

    var opts = {
        uri: args.url,
        method: method,
        followRedirect: false,
        jar: true
    };

    // use the provided cookie jar
    if (args.jar) {
        opts.jar = args.jar;
    }

    // figure out where the data goes:
    if ((args.contentType == 'application/json')
            && (typeof args.data != 'undefined')) {
        opts.json = JSON.parse(args.data);
    } else if (method == 'GET' || method == 'HEAD') {
        opts.qs = args.data;
    } else if (typeof args.data == 'string') {
        opts.body = args.data;
    } else if (typeof args.data == 'object') {
        opts.form = args.data;
    }

    if (args.headers) {
        opts.headers = args.headers;
    }

// console.log(opts);

    request(opts, function (err, res, body) {

// debugging faulty requests:
/*
if ( (opts.uri.indexOf('http://gma.test.zteam.biz/?q=gmaservices/gma_staffReport/searchOwn') != -1)
//        && (opts.method == 'PUT')
   ) {
console.log('req object:');
console.log(t.req);
console.log();
var rqbody = t.req.res.request.body + '';
console.log(rqbody);
console.log('body length: '+rqbody.length);
}
*/
        if (typeof res == 'undefined'){
            console.log('*** error: gma-api.$ajax.request() did not receive an res object');
            console.log('*** perhaps your connection failed');
            res = {statusCode:'??', headers:{ not:'given' }};
        }

        // Deliver results in a similar format as jQuery.ajax()
        var xhr = {
            responseText: body,
            status: res.statusCode,
            getResponseHeader: function (name) {
                return res.headers[String(name).toLowerCase()];
            },
            getAllHeaders: function () {
                return res.headers;
            },
            then: dfd.then,
            fail: dfd.fail,
            done: dfd.done,
            always: dfd.always
        };
//console.log('$ajax err:');
//console.log(err);
//console.log();
//console.log('typeof body:'+typeof body);
//console.log(body);

        if (err) {
            dfd.reject(xhr, "error", err);
        } else if (res.statusCode >= 400) {
            dfd.reject(xhr, "error");
        } else {
            var data = body;
            if (typeof body == 'string') {
                try {
                    data = JSON.parse(body);
                }
                catch(_) {
                    if (args.dataType == 'json') {
                        err = new Error('JSON parse error');
                        dfd.reject(xhr, "error", err);
                    }
                }
            }
            if (!err) {
                dfd.resolve(data, "success", xhr);
            }
        }
    });

    return dfd;
};

module.exports = $ajax;
