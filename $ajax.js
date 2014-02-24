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
    if (method == 'GET' || method == 'HEAD') {
        qs = args.data;
    } else if (args.processData === false) {
        body = args.data;
    } else if (typeof args.data == 'object') {
        form = args.data;
    }

    request({
        uri: args.url,
        method: method,
        qs: qs,
        body: body,
        form: form,
        followRedirect: false,
        jar: true
    }, function (err, res, body) {
        //console.log(err, body);
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
        if (err) {
            dfd.reject(xhr, "error", err);
        } else {
            var data = body;
            try {
                data = JSON.parse(body);
            }
            catch(_) {
                if (args.dataType == 'json') {
                    err = new Error('JSON parse error');
                    dfd.reject(xhr, "error", err);
                }
            }
            if (!err) {
                dfd.resolve(data, "success", xhr);
            }
        }
    });
    
    return dfd;
}

module.exports = $ajax;
