/************************************************************************/
/**
 * @class GMA
 * Joshua Chan <joshua@appdevdesigns.net>
 *
 *  Dependencies for browsers/webviews:
 *    - jQuery
 *    - async
 *
 *  Dependencies for Node.js:
 *    - AppDev framework
 *    - async
 *    - request
 */

var GMA = function (opts) {
    var defaults = {
        // Base URL of the GMA server. Make sure you include the end slash!
        gmaBase: 'http://gma.example.com/',
        // Base URL of the CAS server. Optional if you can obtain your own
        // service ticket for logging in to GMA.
        casURL: 'https://signin.example.com/cas',
        // Optional functions to show/hide busy animations while waiting for GMA
        showBusyAnim: function() {},
        hideBusyAnim: function() {},
        reloginCallback: null,
        // Optional value for an "X-Forwarded-For" http request header
        forwardedFor: false,
        // Optional function for logging warnings and errors
        log: console.log
    };
    this.opts = GMA.Extend(defaults, opts);
    
    // This will be the GMA site page that is fetched to begin the user
    // session. Use this as the service URL when requesting a ticket from CAS.
    this.gmaHome = this.opts.gmaBase + '?q=en/node&destination=node';

    this.isLoggedIn = false;
    this.renId = null;
    this.GUID = null;
    this.isLoading = 0;
    this.jar = false;
    this.tokenCSRF = '';


    // _sessionCache: a set of cached secondary data appropriate to this one connection
    //  .strategies
    this._sessionCache = {

        // cache report options for given nodeIds:
        reportOptions: {
            /*
                nodeId: {  report options }  
                // see .reportOptionsForNodeID() description for data structure
            */
        }

    };
    
    // on Node.js, we need to track our own cookie jar:
    if (typeof module != 'undefined' && module.exports) {
        this.jar = request.jar();
    }
};



if (typeof module != 'undefined' && module.exports) {
    // Node.js
    module.exports = GMA;
    var async = require('async');
    var request = require('request');
    var AD = require('ad-utils');
    GMA.httpRequest = AD.sal.http;
    GMA.Deferred = AD.sal.Deferred;
    GMA.Extend = AD.sal.extend;
    
} else {
    // Browser / webview
    window.GMA = GMA;
    GMA.httpRequest = $.ajax;
    GMA.Deferred = $.Deferred;
    GMA.Extend = $.extend;
}



/**
 * Wrapper for jQuery.ajax(), used internally when requesting GMA web services
 */
GMA.prototype.gmaRequest = function (opts) {
    if (!opts.noAnimation) {
        this.opts.showBusyAnim();
        this.isLoading += 1;
    }

    var self = this;
    var dfd = GMA.Deferred();

    var isParseError = function (err) {
        if (!err || !err.message) {
            return false;
        }
        if (err.message.match(/parse error|unexpected end of input|parse.+?unexpected/i)) {
            return true;
        }
        return false;
    };
    
    // Adjust the qs path for staff/director reports. Default is staff.
    if (opts.role == 'director') {
        opts.path = opts.path.replace('[ROLE]', 'director');
    } else {
        opts.path = opts.path.replace('[ROLE]', 'staff');
    }

    var reqParams = {
            url: self.opts.gmaBase + opts.path,
            type: opts.method,
            data: (typeof opts.data != 'undefined') ?
                    JSON.stringify(opts.data) : opts.data,
            dataType: opts.dataType || 'json',
            contentType: 'application/json',
            cache: false,
            headers: { 'X-CSRF-Token': self.tokenCSRF }
        };

    if (this.opts.forwardedFor) {
        reqParams.headers['X-Forwarded-For'] = this.opts.forwardedFor;
    }

    // pass in our local cookie jar if it exists
    if (this.jar) {
        reqParams.jar = this.jar;
    }


    GMA.httpRequest(reqParams)
    .always(function(){
        if (!opts.noAnimation) {
            self.isLoading -= 1;
            if (self.isLoading <= 0) {
                self.opts.hideBusyAnim();
            }
        }
    })
    .fail(function(res, status, err){

        if (isParseError(err)) {
            // JSON parse error usually means the session timed out and
            // the Drupal site has redirected to the CAS login page
            // instead of serving up a JSON response.
            if (self.opts.reloginCallback) {
                opts.reloginCallback()
                .done(function(){
                    // Resend the request
                    self.gmaRequest(opts)
                    .done(function(res, status, err){
                        dfd.resolve(res, status, err);
                    });
                })
                .fail(function(err){
                    self.opts.log("Relogin failed", err);
                });
            } else {
                // Deliver a hopefully more helpful error
                self.opts.log("Session timeout?", err);
                dfd.reject(res, status, new Error("Login session timed out"));
            }
        }
        else {
            dfd.reject(res, status, err);
        }
    })
    .done(function(data, status, res){
        dfd.resolve(data, status, res);
    });

    return dfd;
};


// This lookup is used to determine the appropriate key for parsing
// the various GMA webservice responses.
GMA.responseKey = {
    staff: {
        type: 'staff',
        reports: 'staffReports',
        id: 'staffReportId'
    },
    director: {
        type: 'director',
        reports: 'directorReports',
        id: 'directorReportId'
    }
};



// This lookup caches the standard GMA system settings
//  these should be system wide settings
GMA._systemSettings = {

    // attempt to provide a language_code to languageName lookup:
    langcodeToName: {
        'en'        : 'English',
        'ko'        : '한국어',
        'zh-hans'   : '中文'
    },

    /*
    languages:[
        { languageId:id1,  languageName:'name1'},
        { languageId:id2,  languageName:'name2'},
        ...
        { languageId:idN,  langaugeName:'nameN'}
    ]
    */
}



/**
 * @function login
 *
 * Uses the CAS RESTful interface to log in to the GMA site.
 * Further requests to GMA will be authenticated because of the browser
 * cookie used by jQuery.ajax().
 *
 * @param string username
 * @param string password
 * @return jQuery Deferred
 */
GMA.prototype.login = function (username, password) {
    var dfd = GMA.Deferred();
    var self = this;
    
    self.restfulCasTicket(username, password)
    .fail(function(err){
     dfd.reject(err);
    })
    .done(function(st){
        self.loginWithTicket(st)
        .fail(function(err){
            dfd.reject(err);
        })
        .done(function(){
            dfd.resolve();
        });
    });

    return dfd;
};



/**
 * @function restfulCasTicket
 *
 * Uses the CAS RESTful interface to obtain a CAS service ticket for GMA.
 *
 * @param string username
 * @param string password
 * @return jQuery Deferred
 */
GMA.prototype.restfulCasTicket = function (username, password) {
    var tgt;
    var st;
    var dfd = GMA.Deferred();
    var self = this;

    self.opts.showBusyAnim();
    async.series([

        // Step 1: Get the TGT
        function(next){

            var reqParams = {
                url: self.opts.casURL + "/v1/tickets",
                type: "POST",
                cache: false,
                data: { username: username, password: password }
            };
            if (self.jar) reqParams.jar = self.jar;

            GMA.httpRequest(reqParams)
            .done(function(data, textStatus, res){
                tgt = res.getResponseHeader('Location');
                if (tgt) {
                    next();
                } else {
                    self.opts.log(data, textStatus, res);
                    next(new Error('Credentials were not accepted'));
                }
            })
            .fail(function(res, textStatus, err){
                if (err instanceof Error) {
                    if (!err.message) {
                        err.message = "[" + textStatus + ": " + res.status + "]";
                    }
                    next(err);
                } else {
                    var message;
                    switch (parseInt(res.status)) {
                        case 404:
                            message = 'Make sure your VPN and server settings are correct';
                            break;
                        case 400:
                            message = 'Credentials were not accepted';
                            break;
                        default:
                            message = textStatus + ': ' + res.status;
                            break;
                    }
                    next(new Error(message));
                }
            });
        },
        // Step 2: Get the ST
        function(next){
            var reqParams = {
                url: tgt,
                type: "POST",
                data: { service: self.gmaHome }
            };
            if (self.jar) reqParams.jar = self.jar;

            GMA.httpRequest(reqParams)
            .done(function(data, textStatus, res){
                // Credentials verified by CAS server. We now have the
                // service ticket.
                st = data;
                next();
            })
            .fail(function(res, textStatus, err){
                next(err);
            });
        }

    ], function(err){
        self.opts.hideBusyAnim();
        if (err) {
            // All failures from above are caught here
            dfd.reject(err);
        } else {
            dfd.resolve(st);
        }
    });

    return dfd;
};



/**
 * @function loginWithTicket
 *
 * Logs in to GMA using a service/proxy ticket that was already obtained,
 * such as with a CAS proxy.
 *
 * Further requests to GMA will be authenticated because of the browser
 * cookie.
 *
 * @param string ticket
 * @return jQuery Deferred
 */
GMA.prototype.loginWithTicket = function (ticket) {
    var dfd = GMA.Deferred();
    var self = this;

    self.opts.showBusyAnim();
    async.series([

        // Step 0: Make sure we are not already logged in
        function(next){
            if (self.isLoggedIn) {
                self.opts.log("Logging out first to reset session");
                self.logout()
                .always(function(){ next(); });
            } else {
                next();
            }
        },
        // Step 1: Log in to GMA
        function(next){
            var finalURL = self.gmaHome +
                (self.gmaHome.match(/[?]/) ? "&" : '?') +
                "ticket=" + ticket;

            var reqParams = {
                url: finalURL,
                type: "GET"
            };
            if (self.jar) reqParams.jar = self.jar;

            if (self.opts.forwardedFor) {
                reqParams.headers = { 'X-Forwarded-For' : self.opts.forwardedFor };
            }

            GMA.httpRequest(reqParams)
            .done(function(data, textStatus, res){
                if (data.match(/CAS Authentication failed/)) {
                    // Authentication problem on the Drupal site
                    next(new Error("Sorry, there was a problem authenticating with the server"));
                } else {
                    // The session cookie has now been set
                    next();
                }
            })
            .fail(function(res, textStatus, err){
                if (!err) {
                    err = new Error("Login failed");
                }
                next(err);
            });
        },
        // Step 2: Fetch the Drupal CSRF token
        function(next){
            var reqParams = {
                url: self.opts.gmaBase + '?q=services/session/token',
                type: "GET"
            };

            if (self.opts.forwardedFor) {
                reqParams.headers = { 'X-Forwarded-For' : self.opts.forwardedFor };
            }

            if (self.jar) reqParams.jar = self.jar;

            GMA.httpRequest(reqParams)
            .done(function(data, textStatus, res){
                self.tokenCSRF = data;
                next();
            })
            .fail(function(res, textStatus, err){
                self.opts.log('Unable to get CSRF token.  [res, textStatus, err]:', res, textStatus, err);

                // Don't fail on this error in case we are on Drupal 6
                // instead of Drupal 7.
                next();
            });
        },
        // Step 3: Get user info
        function(next){
            self.getUser()
            .done(function(){ next(); })
            .fail(function(err){
                // We have logged in to the GMA Drupal site
                // but the user doesn't have access to the GMA system there.
                // Log out of the Drupal site.
                self.logout();
                if (!err) {
                    err = new Error("Could not get user info");
                }
                next(err);
            });
        }

    ], function(err){
        self.opts.hideBusyAnim();
        if (err) {
            // All failures from above are caught here
            dfd.reject(err);
        } else {
            dfd.resolve();
        }
    });

    return dfd;
};



/**
 * @function getUser
 *
 * @return jQuery Deferred
 *      resolves with parameter `ren` {
 *          renId: int,
 *          renPreferredName: string,
 *          GUID: string
 *      }
 */
GMA.prototype.getUser = function () {
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_user&type=current';

    self.gmaRequest({
        path: servicePath,
        method: 'GET'
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    })
    .done(function(data, textStatus, res){
        if (data.success) {
            var ren = data.data[0];
            self.preferredName = ren.preferredName;
            self.renId = ren.renId;
            self.GUID = ren.GUID;
            dfd.resolve(ren);
        }
        else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            dfd.reject(err);
        }
    });

    return dfd;
};



/**
 * @function getAssignments
 *
 * Delivers the GMA nodes that the user is assigned to.
 *
 * @param string role (Optional) 'staff' or 'director'
 * @return jQuery Deferred
 *      resolves with three parameters
 *      - assignmentsByID { 101: "Assign1", 120: "Assign2", ... }
 *      - assignmentsByName { "Assign1": 101, "Assign2": 120, ... }
 *      - listAssignments [ { AssignmentObj1 }, { AssignmentObj2 }, ... ]
 */
GMA.prototype.getAssignments = function (role) {
    role = role || 'staff';
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_user/' + self.renId + '/assignments/[ROLE]';
    var typeKey = GMA.responseKey[role].type;
    
    self.gmaRequest({
        role: role,
        path: servicePath,
        method: 'GET'
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    })
    .done(function(data, textStatus, res){
        if (data.success) {
            // Create two basic lookup objects indexed by nodeId and by name
            var assignmentsByID = {};
            var assignmentsByName = {};
            // and one array of Assignment objects
            var listAssignments = [];

            if (data.data[typeKey]) {
                for (var i=0; i<data.data[typeKey].length; i++) {
                    var nodeId = data.data[typeKey][i].nodeId;
                    var shortName = data.data[typeKey][i].shortName;

                    assignmentsByID[nodeId] = shortName;
                    assignmentsByName[shortName] = nodeId;

                    listAssignments.push(new Assignment({
                        gma: self,
                        nodeId: nodeId,
                        shortName: shortName,
                        role: role
                    }));
                }
            }
            dfd.resolve(assignmentsByID, assignmentsByName, listAssignments);
        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            dfd.reject(err);
            self.opts.log(data);
        }
    });

    return dfd;
};



/**
 * @function getLanguages
 *
 * Return an array of languages supported by the current GMA system.
 *
 * @param string role (Optional) 'staff' or 'director'
 * @return jQuery Deferred
 *      resolves with array:
 *      [
 *          { languageId:id1,  languageName:'name1'},
 *          { languageId:id2,  languageName:'code2'},
 *          ...
 *          { languageId:idN,  langaugeName:'codeN'}
 *      ]
 */
GMA.prototype.getLanguages = function() {
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_language';

    

    // if we have already cached this info: return that
    if (GMA._systemSettings.languages) {

        dfd.resolve(GMA._systemSettings.languages);

    // else run the request:
    } else {

        self.gmaRequest({
            // role: role,
            path: servicePath,
            method: 'GET'
        })
        .fail(function(res, textStatus, err){

            err.service_message = 'error in GMA.getLanguages() ';
            dfd.reject(err);
        })
        .done(function(data, textStatus, res){

            if (data.success) {

                if (data.data) {

                    // store this info for later:
                    GMA._systemSettings.languages = data.data;
                    dfd.resolve(data.data);
                } else {

                    // complain ... this just isn't right!
                    dfd.reject(new Error('NO_DATA: GMA.getLanguages() did not return any data.  Bad!'));
                }

            } else {
                var err = new Error(data.error.errorMessage);
                err.origin = servicePath;
                self.opts.log(data);
                dfd.reject(err);
            }
        });

    }

    return dfd;

}



/**
 * @function measurementsForNodeID
 *
 * Return an array of GMA measurements related to a given nodeId.
 *
 * @param {integer} nodeId The node id to get strategies for
 *
 * @return jQuery Deferred
 *      resolves with object:
 *      {
 *          "numericList": [
 *              {
 *                  "id1": "name1"
 *              },
 *              {
 *                  "id2": "name2"
 *              },
 *              ...
 *              {
 *                  "idN": "nameN"
 *              }
 *          ],
 *          "calculatedList": null
 *      }
 */
GMA.prototype.measurementsForNodeID = function(nodeId) {
    var dfd = GMA.Deferred();

    // reuse our reportOptionsForNodeID() 
    this.reportOptionsForNodeID(nodeId)
    .fail(function(err){
        dfd.reject(err);
    })
    .done(function(data){
        dfd.resolve(data.measurementSelection);
    });

    return dfd;
}



/**
 * @function reportOptionsForNodeID
 *
 * Return the GMA report option data for a given nodeId.
 *
 * @param {integer} nodeId The node id to get option info for
 *
 * @return jQuery Deferred
 *      resolves with object:
 *      {
 *           "translation": {
 *               "field1": "translation1",
 *               "field2": "translation2",
 *               ...
 *               "fieldN": "translationN"
 *           },
 *           "dateRange": [
 *               {
 *                   "relative": [
 *                       { "1": "Last Period" },
 *                       { "2": "Last 3 Periods" },
 *                       { "3": "Last 6 Periods" },
 *                       { "4": "Last 12 Periods" }
 *                   ]
 *               },
 *               {
 *                   "fixed": {
 *                       "from": "",  // empty "" means you provide the value
 *                       "to": ""
 *                   }
 *               }
 *           ],
 *           "reportFormat": [
 *               {
 *                   "byReportingInterval": {
 *                       "granularity": [
 *                           { "2": "Monthly" },
 *                           {  "3": "Quarterly" },
 *                           { "4": "Half-Yearly" },
 *                           { "5": "Yearly" }
 *                       ],
 *                       "showTotalColumn": [ true, false ]
 *                   }
 *               },
 *               {
 *                   "byOrganizationStructure": { "showLastModifiedDate": [ true, false ]  }
 *               },
 *               {
 *                   "byStrategyStructure": { "showTotalColumn": [ true, false ] }
 *               },
 *               {
 *                   "byStaff": { "showTotalColumn": [ true, false ] }
 *               }
 *           ],
 *           "organizationSelection": [
 *               { "id": "name" }
 *           ],
 *           "strategySelection": [
 *               { "id1": "name1" },
 *               { "id2": "name2" },
 *               ...
 *               { "idN": "nameN" }
 *           ],
 *           "measurementSelection": {
 *               "numericList": [
 *                   { "id1": "name1" },
 *                   { "id2": "name2" },
 *                   ...
 *                   { "idN": "nameN" }
 *               ],
 *               "calculatedList": null
 *           }
 *      }
 */
GMA.prototype.reportOptionsForNodeID = function(nodeId) {
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_advancedReport/{nodeId}/options';


    // if we have already cached this info: return that
    if (this._sessionCache.reportOptions[nodeId]) {
 
        dfd.resolve(this._sessionCache.reportOptions[nodeId]);

    // else run the request:
    } else {

        var url = servicePath.replace('{nodeId}', nodeId);
        self.gmaRequest({
            path: url,
            method: 'GET'
        })
        .fail(function(res, textStatus, err){

            err.service_message = 'error in GMA.reportOptionsForNodeID() ';
            dfd.reject(err);
        })
        .done(function(data, textStatus, res){

            if (data.success) {

                if (data.data) {

                    // store this info for later:
                    self._sessionCache.reportOptions[nodeId] = data.data;
                    dfd.resolve(data.data);
                } else {

                    // complain ... this just isn't right!
                    dfd.reject(new Error('NO_DATA: GMA.reportOptionsForNodeID() did not return any data.  Bad!'));
                }

            } else {
                var err = new Error(data.error.errorMessage);
                err.origin = servicePath;
                err.service_message = 'error in GMA.reportOptionsForNodeID()';
                self.opts.log(data);
                dfd.reject(err);
            }
        });

    }

    return dfd;

}



/**
 * @function strategiesForNodeID
 *
 * Return an array of GMA strategy definitions for given nodeId.
 *
 * @param {integer} nodeId The node id to get strategies for
 *
 * @return jQuery Deferred
 *      resolves with array:
 *      [
 *          { languageId:id1,  languageName:'name1'},
 *          { languageId:id2,  languageName:'code2'},
 *          ...
 *          { languageId:idN,  langaugeName:'codeN'}
 *      ]
 */
GMA.prototype.strategiesForNodeID = function(nodeId) {
    var dfd = GMA.Deferred();

    // reuse our reportOptionsForNodeID() 
    this.reportOptionsForNodeID(nodeId)
    .fail(function(err){
        dfd.reject(err);
    })
    .done(function(data){
        dfd.resolve(data.strategySelection);
    });

    return dfd;

}



/**
 * @function getGraphData
 *
 * Queries the GMA server for measurement values of a Node over several 
 * reporting intervals.
 *
 * Used internally by Assignments.getGraphData()
 *
 * The options include:
 *
 * @param {integer} nodeID
 *      The organization node id value (Assignment.nodeId).
 * @param {array/string/integer} strategies
 *      (optional)  if not provided, all strategies will be enabled.
 *      {string}    if a single string is given, we will use this to match the GMA strategy name
 *      {integer}   if an integer is provided, then we will use this to match the GMA strategy id
 *      {array}     more than 1 strategy name/id can be provided.
 * @param {string} startDate
 *      (optional)  If not provided, then default to 13 months ago
 *(     format:  YYYYMMDD
 * @param {string} endDate
 *      (optional) If not provided, then default to 1 month ago
 *      format: YYYYMMDD
 * @param {array} measurements
 *      (optional) An array of measurement_id values.  If not provided, then all measurements 
 *                 associated with a node will be requested.
 * @param {integer/string} language
 *      (Optional) if not provided, then results will be in user's default GMA 
 *                 language
 *      {integer}  you can provide the GMA index of the language you want to use
 *      {string}   or you can provide the string language_code you want to attempt to match
 *                 if no match is found, then we return to the default
 * @return {deferred}
 *
 *      The deferred with be resolved with a data structure in this format:
 *
 *  {
 *      nodeId:1,
 *      title:'Report Title Here',
 *      info:'Say some descriptive info about how there are only 67% reporting on this report like you currently do',
 *      periods: [ 'date1', 'date2', ... 'dateP' ],
 *      strategies: [
 *          { id:1,  name:'strategyName1' },
 *          { id:2,  name:'strategyName2' },
 *          ...
 *          { id:N,  name:'strategyNameN' }
 *      ],
 *      measurements:[
 *          { id:1, name:'measurementName1',  strategyId:1,  values:[ v1, v2, ... vP ] },
 *          { id:2, name:'measurementName2',  strategyId:1,  values:[ v1, v2, ... vP ] },
 *          ...
 *          { id:M, name:'measurementNameM',  strategyId:N,  values:[ v1, v2, ... vP ] },
 *      ]
 *  }
 *
 */
GMA.prototype.getGraphData = function (options) {
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_advancedReport/{nodeId}/generate';


    // nodeID is required!
    var nodeID = options.nodeId || null;
    if (nodeID == null) {
        dfd.reject(new Error('INVALID_PARAMS: missing nodeID in call to GMA.getGraphData()'));
        return dfd;
    }


    // default start and end dates should be the previous 12 months
    var startDate = options.startDate;
    var endDate   = options.endDate;
    if (!startDate) {
        // default to 12 months ago:
        var now = new Date();
        var date12MonthsAgo = new Date(new Date(now).setMonth(now.getMonth()-12));
        // iso string:  'yyyy-mm-ddThh:mm:ss.tttZ'
        // we want: yyyymmdd
        startDate = date12MonthsAgo.toISOString().split('T')[0].split('-').join('');
    }
    if (!endDate) {
        // default to 1 month ago:
        var now = new Date();
        date1MonthAgo = new Date(new Date(now).setMonth(now.getMonth()-1));
        // iso string:  'yyyy-mm-ddThh:mm:ss.tttZ'
        // we want: yyyymmdd
        endDate = date1MonthAgo.toISOString().split('T')[0].split('-').join('');
    }


    // strategy list:
    // make sure we end up with an array of values here:
    var strategyList = [];  // array of strategy id's used in call to graph service
    var strategies = options.strategies || [];
    if (!strategies.length) {
        // if ! array, make it one:
        strategies = [strategies];
    }
    var stratNameHash = {}; // { 'stratName' : 'id' }


    // measurements are optional!
    var measurementList = [];  // array of measurement ids being sent to our web service
    var measurements = options.measurements || null;    // provided measurements
    if (measurements == null) {
        measurements = [];  // default to empty []
    }
    var measurementNameHash = {};  // { 'measureName' : 'id' }

    // language 
    var LanguageURL = '';        // url addition for non default language
    var language = options.language || null;


//// Question: do we allow setting granularity? 


    // This is the JSON options object to be sent to the GMA webservice
    var serviceOptions = null; 

    var xmlData = null;  // the XML data returned from the web service

    var finalResults = null;      // What we are actually returning from this method:


    async.series([

        // step 1: resolve language options:
        function(next) {

            // if no language option provide ... skip
            if (language == null) {

                next();
            } else {

                // get current language settings:
                self.getLanguages()
                .fail(function(err){
                    next(err);
                })
                .done(function(list){

                    // provided language could either be by ID or Name
                    // see if we can find it in our list
                    var foundLanguage = null;
                    var nameForCode = GMA._systemSettings.langcodeToName[language];  // maybe language was a language_code : 'en', 'ko', 'zh-hans', ... 
                    list.forEach(function(entry){

                        if ((entry.languageId == language)
                            || (entry.languageName == language)
                            || (entry.languageName == nameForCode)) {
                            foundLanguage = entry;
                        }
                    })

                    // if we found it, update our languageURL
                    if (foundLanguage) {
                       LanguageURL = foundLanguage.languageId;
                    } else {
                        self.opts.log('warning: no language in GMA matched given language value:'+langauge);
                        self.opts.log('ignoring language parameter.')
                    }

                    next();

                })

            }

        }, 


        // step 2:  resolve the Strategy info:
        function(next) {

            self.strategiesForNodeID(nodeID)
            .fail(function(err){
                next(err);
            })
            .done(function(list){

                // convert this list into a hash:
                list.forEach(function(entry){
                    for(var id in entry) {
                        /* { name : id } */
                        stratNameHash[entry[id]] = id;
                    }
                })

                // if we were given strategies to consider:
                if (strategies.length > 0) {

                    // for each requested strategy
                    strategies.forEach(function(strat){

                        var thisStratFound = false; // did I find a match for the current strat?

                        list.forEach(function(entry){

                            for(var id in entry) {

                                // if given strategy value matches either the id or name:
                                if ((strat == id)
                                    || (strat == entry[id])) {

                                    // push the id 
                                    strategyList.push(id);
                                    thisStratFound = true;  // yay!
                                }
                            }
                        })

                        // post a warning if given strat was not found
                        if (!thisStratFound) {
                            AD.log('<yellow>warn:</yellow> strategy entry ['+strat+'] was not found in GMA associated with this node.');
                        }
                    })

                } 

                // if we didn't get any matches, then default to all strategies
                if (strategyList.length == 0) {
                    self.opts.log('warn: no strategies matched the given set, so ignoring');

                    list.forEach(function(entry) {

                        /*  entry =  { id : 'name' } */
                        // push the id onto strategyList
                        for (var id in entry) {
                            strategyList.push(id);
                        }
                    })

                }

                next();
            })
        },


        // step 3: make sure our measurements make sense
        // default to all measurements if not given:
        function(next) {

            self.measurementsForNodeID(nodeID)
            .fail(function(err){
                next(err);
            })
            .done(function(info){

                var list = info.numericList;

                list.forEach(function(entry) {

                    for(var id in entry) {
                        /* { name: id } */
                        measurementNameHash[entry[id]] = id;
                    }
                })
                

                // if we were given measurements to consider:
                if (measurements.length > 0) {

                    //// verify they match with what is reported from GMA:

                    // for each requested measurement
                    measurements.forEach(function(measure){

                        var thisMeasureFound = false; // did I find a match for the current strat?

                        list.forEach(function(entry){

                            for(var id in entry) {

                                // if given strategy value matches either the id or name:
                                if ((measure == id)
                                    || (measure == entry[id])) {

                                    // push the id 
                                    measurementList.push(id);
                                    thisMeasureFound = true;  // yay!
                                }
                            }
                        })

                        // post a warning if given strat was not found
                        if (!thisMeasureFound) {
                            AD.log('<yellow>warn:</yellow> measurement entry ['+measure+'] was not found in GMA associated with this node.');
                        }
                    })

                } 

//// TODO: figure out if this is required by the web service.
////       maybe it allows you to not specify any measurements?
////       the documentation is not clear on this.

                // if we didn't get any matches, then default to all measurements
                if (measurementList.length == 0) {
                    self.opts.log('warn: defaulting to all measurements');

                    list.forEach(function(entry) {

                        /*  entry =  { id : 'name' } */
                        // push the id onto measurementList
                        for (var id in entry) {
                            measurementList.push(id);
                        }
                    })

                }

                next();
            });

        },

        
        // step 4: now put together the serviceOption data structure to 
        // submit with the service call:
        function(next){

            serviceOptions = {
                dateRange: {
                    fixed: {
                        from: startDate,
                        to: endDate
                    }
                },
                reportFormat: { 
                    byReportingInterval: {
                        showTotalColumn: false,
                        granularity: 2 // monthly
                    }
                },
                organizationSelection: [ nodeID ],
                strategySelection: strategyList,
                measurementSelection: {
                    calculatedList: [],
                    numericList: measurementList
                }
            };

            next();

        },


        // step 5:  now make the call to our web service!
        function(next) {

            var url = servicePath.replace('{nodeId}', nodeID);
            self.opts.log('... calling graph data url ['+url+']');
            self.gmaRequest({
                path: url,
                method: 'POST',
                data:serviceOptions
            })
            .fail(function(res, textStatus, err){
                next(err);
            })
            .done(function(data){

                // the data returned is in base64 encoded string
                // we load that into a buffer
                xmlData = new Buffer(data.data, 'base64');
                next(); 
            })
           

        },



        // step 6: parse the xml data
        function(next) {

            var XLS = require('xlsx');
            var workbook = XLS.read(xmlData, {type:"binary"});


            finalResults = {
                nodeId:nodeID,
            }

            var sheet = workbook.Sheets['generated report'];
            finalResults.title = sheet['A1'].v;  
            finalResults.info  = sheet['A4'].v;

            // the data to pull:
            finalResults.periods = [];
            finalResults.strategies = [];
            finalResults.measurements = [];


            // 1) pull the periods:
            //  to do this, we have to figure out how many periods were returned:
            //  they all exist in the same row, so figure out the beginning col and end cols:
            colStart = '';
            periodEnd = '';

            var nextCol = function(curr) {
                var next = curr.charCodeAt(0);
                next++;
                return String.fromCharCode(next);
            }

            // find the beginning column
            var col = '@';  // the ascii char before 'A'
            var dateRow = 5;
            var cell;
            while (typeof cell == 'undefined') {
                col = nextCol(col);
                cell = sheet[col+dateRow]
            }
            colStart = col;

            // now store values and keep track of the last valid value (the end col)
            while (typeof cell != 'undefined') {
                finalResults.periods.push( cell.v );
                colEnd = col;
                col = nextCol(col);
                cell = sheet[col+dateRow];
            }

//// TODO: verify how each Strategy is listed on a form with > 1 strategy
//// with responses on it.

            // Now parse the Strategy & Measurements:
            var stratRow = 6; 
            var currStratID = -1;

            var recursiveRowProcessor = function(row) {

                // if there is no A[row] then there are no more rows to process
//// NOT SURE THIS IS A VALID ASSUMPTION FOR >1 STRATEGY REPORTS.    
                if ( typeof sheet['A'+row] == 'undefined' ) {

                    // if there are spaces we need to check to see if we are at the
                    // end of specified range of information:
                    //      sheet["!ref"]: "A1:M7"  -->  so if row <= 7 continue on

                } else { 

                    var name = sheet['A'+row].v;

                    // if current row matches a strategy name:
                    if (typeof stratNameHash[name] != 'undefined') {

                        // update strat entry 
                        currStratID = stratNameHash[name];
                        finalResults.strategies.push( { id:currStratID, name:name });

                    } else {

                        // create Measurement entry
                        var measurement = {};

                        measurement.id = -1;  // how are we going to figure this out?
                        measurement.name = name;

                        for (var sName in stratNameHash) {

                            var lookup = name+' - '+sName;
                            if ( measurementNameHash[lookup]) {
                                measurement.id = measurementNameHash[lookup];
                            }
                        }

                        measurement.strategyId = currStratID;

                        measurement.values = [];

                        // parse the line of value info:
                        var col = colStart;
                        var cell = sheet[col+row];
                        while ( typeof cell != 'undefined') {
                            measurement.values.push(cell.v);
                            col = nextCol(col);
                            cell = sheet[col+row];
                        }

                        finalResults.measurements.push(measurement);
                    }

                    // do next row
                    recursiveRowProcessor(row+1);
                    
                }

            }

            recursiveRowProcessor(stratRow);  // Not Asynchronous

            next();

        }


    ],function(err,results){

        if (err) {
            dfd.reject(err);
        } else {
            dfd.resolve(finalResults);
        }

    })

    return dfd;
}



/**
 * @function getReport
 *
 * Delivers a Report object instance associated with a given reportId.
 *
 * Useful when you need to get a given report's measurements without first 
 * fetching all of the other reports in the node.
 *
 * @param int reportId
 * @param string role (Optional)
 * @return Report
 */
GMA.prototype.getReport = function (reportId, role) {
    role = role || 'staff';
    var report = new Report({
        gma: this,
        role: role,
        reportId: reportId,
        nodeId: null,
        startDate: null,
        endDate: null
    });
    
    return report;
}



/**
 * @function getMeasurement
 *
 * Delivers a Measurement object instance associated with a given reportId
 * and measurementId.
 *
 * Useful when you need to set a measurement's value without first fetching
 * its report.
 *
 * @param int measurementId
 * @param int reportId
 * @param string role (Optional)
 * @return Measurement
 */
GMA.prototype.getMeasurement = function (measurementId, reportId, role) {
    role = role || 'staff';
    var report = new Measurement({
        gma: this,
        role: role,
        reportId: reportId,
        measurementId: measurementId
    });
    
    return report;
}





/**
 * @function getReportsForNode
 *
 * Delivers an array of up to ten Report objects for reports within
 * the specified node.
 *
 * @param int nodeId
 * @param string role (Optional) 'staff' or 'director'
 * @return jQuery Deferred
 *      resolves with :
 *      - []  if no report found
 *      - [ {ReportObj1}, {ReportObj2}, ... ]
 */
GMA.prototype.getReportsForNode = function (nodeId, role) {
    role = role || 'staff';
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/searchOwn';
    
    var reportKey = GMA.responseKey[role].reports;
    var idKey = GMA.responseKey[role].id;
    
    self.gmaRequest({
        role: role,
        path: servicePath,
        method: 'POST',
        data: {
            nodeId: [nodeId],
            maxResult: 10
        }
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    })
    .done(function(data, textStatus, res){
        if (data.success) {

            if (!data.data[reportKey]) {
                // so return an empty array:
                dfd.resolve([]);
            }
            else {

                var reports = [];
                for (var i=0; i<data.data[reportKey].length; i++) {

                    // NOTE: it's possible the web service wont actually filter
                    // based on the given nodeId (I've seen it), so we need to
                    // verify which reports belong to this nodeId:

                    // if this report belongs to this nodeId
                    if (nodeId == data.data[reportKey][i].node.nodeId) {

                        var reportId = data.data[reportKey][i][idKey];
                        var nodeName = data.data[reportKey][i].node.shortName;
                        reports.unshift(new Report({
                            gma: self,
                            role: role,
                            reportId: reportId,
                            nodeId: data.data[reportKey][i].node.nodeId,
                            nodeName: nodeName,
                            startDate: data.data[reportKey][i].startDate,
                            endDate: data.data[reportKey][i].endDate
                        }));
                    }
                }
                dfd.resolve(reports);
            }

        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            self.opts.log(data);
            dfd.reject(err);
        }
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    });

    return dfd;
};



/**
 * @function logout
 *
 * Logs out of the Drupal website that GMA is on.
 *
 * @return jQuery Deferred
 */
GMA.prototype.logout = function () {
    var dfd = GMA.Deferred();
    var self = this;

    self.gmaRequest({
        path: '?q=logout',
        method: 'HEAD',
        dataType: 'html'
    })
    .done(function(){
        self.isLoggedIn = false;
        self.renId = null;
        self.GUID = null;
        dfd.resolve();
    })
    .fail(function(res, status, err){
        dfd.reject(err);
    });

    return dfd;
};



/************************************************************************/
/**
 * @class Assignment
 */

var Assignment = function(data) {

    this.gma = data.gma;

    this.nodeId = data.nodeId;
    this.shortName = data.shortName;
    this.role = data.role; // staff vs director

};



/**
 * @function getMeasurements
 *
 * lookup a list of Measurements associated with this Assignment.
 *
 * @param string role (Optional) 'staff' or 'director'
 * @return jQuery Deferred
 *      resolves with
 *      - []  if no Measurements found
 *      - [{MeasurementObj1}, {MeasurementObj2}, ... ]
 */
Assignment.prototype.getMeasurements = function (role) {
    var dfd = GMA.Deferred();
    var self = this;

    this.gma.getReportsForNode(this.nodeId, role)
    .fail(function(err){
        self.gma.opts.log('  *** Assignemnt.getMeasurement() error finding reports...');
        dfd.reject(err);
    })
    .done(function(listReports) {

        if (listReports.length == 0) {
            self.gma.opts.log('  --- Assignment.getMeasurements():  no reports returned ... ');
            // no measurements for this assignment...
            dfd.resolve([]);

        } else {

            listReports[0].measurements()
            .fail(function(err){
                self.gma.opts.log('  *** Assignment.getMeasurements(): report.measurement()  had and error:');
                self.gma.opts.log(err);
                dfd.reject(err);
            })
            .done(function(list){
                // list = {
                //    'strategyName':[ measurements ],
                //    'strategyName2':[ measuremenList2 ],
                //      ...
                //  }

                // Assumption: We will automatically choose the 1st strategy since
                // in our ministry context it makes since for ren to report on a node
                // with only 1 strategy:

                // *** : ok, ran into an issue where this bit us!  
                //       Testing out NextSteps server we were given a Node with 3 strategies
                //       which resulted in a crash.  We fixed the crash but this question
                //       remains ... what to do with multiple strategies?
                //       --> currently we are waiting until a real life example crops up and
                //           then deal with the customers then to figure this out.
                for (var strategy in list) {
                    dfd.resolve(list[strategy]);
                    return;
                }

                // if I get here, I didn't get any results ...
                dfd.resolve([]); // return no measurements
            });
        }
    });

    return dfd;
};




/************************************************************************/
/**
 * @class Report
 */

var Report = function(data) {

    this.gma = data.gma;
    
    this.role = data.role; // director vs staff
    this.reportId = data.reportId;
    this.nodeId = data.nodeId;
    this.nodeName = data.nodeName;
    this.startDate = data.startDate;
    this.endDate = data.endDate;

    this._measurements = null;

};



/**
 * @function id
 *
 * return the unique id for this Report
 *
 * @return int reportId
 */
Report.prototype.id = function () {
    return this.reportId;
};



/**
 * @function measurements
 *
 * Delivers a bunch of Measurement objects in this format:
 * {
 *     "Strategy Name 1": [
 *          Measurement1.1,
 *          Measurement1.2,
 *          ...
 *      ],
 *      "Strategy Name 2": [
 *          Measurement2.1,
 *          Measurement2.2,
 *          ...
 *      ],
 *      ...
 * }
 *
 * @return jQuery Deferred
 */
Report.prototype.measurements = function () {
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/' + self.reportId + '/numeric';
    var role = self.role;

    self.gma.gmaRequest({
        role: role,
        path: servicePath,
        method: 'GET'
    })
    .fail(function(res, textStatus, err) {
        dfd.reject(err);
    })
    .done(function(data, textStatus, res) {
        if (data.success) {

            // Parse through the layers of JSON structure
            // and make our own structure that suits us better.
            var results = {};

            var numerics = data.data.numericMeasurements;

            // 1st layer is an array of objects
            for (var i=0; i<numerics.length; i++) {

                var strategy = numerics[i];

                // 2nd layer is an object with a single property
                for (var strategyName in strategy) {

                    var measurements = strategy[strategyName];
                    results[strategyName] = [];

                    // 3rd layer is an array of objects
                    for (var j=0; j<measurements.length; j++) {

                        var info = measurements[j];
                        var newMeasurement = new Measurement({
                            gma: self.gma,
                            report: self,
                            reportId: self.reportId,
                            measurementId: info.measurementId,
                            measurementName: info.measurementName,
                            measurementDescription: info.measurementDescription,
                            measurementValue: info.measurementValue,
                            role: role
                        });

                        // record this in our results
                        results[strategyName].push(newMeasurement);

                        // keep track of the measurements for this report
                        //// NOTE: this is a single list of ALL measurements across strategies.
                        ////       is this going to be safe for saving() the report?
                        if (self._measurements == null) self._measurements = {};
                        self._measurements[newMeasurement.id()] = newMeasurement;
                    }
                }
            }

            dfd.resolve(results);

        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            dfd.reject(err);
        }
    });

    return dfd;
};



/**
 * @function formatDate
 *
 * return a more readable date string than what is provided from GMA.
 *
 * @param string ymd  the GMA date string ("YYYYMMDD")
 * @return string
 */
Report.formatDate = function (ymd) {
    return ymd.substr(0, 4) + '-'
         + ymd.substr(4, 2) + '-'
         + ymd.substr(6, 2);
};



/**
 * @function period
 *
 * return a formatted string representing the "start date - end date" for this
 * report.
 *
 * @return string
 */
Report.prototype.period = function () {
    return Report.formatDate(this.startDate)
            + ' &ndash; '
            + Report.formatDate(this.endDate);
};



/**
 * @function reportForDate
 *
 * return a report object from the same Assignment (node) that is valid for the provided date.
 *
 * @param string ymd
 * @param string role (Optional) 'staff' or 'director'
 * @return jQuery Deferred
 *      resolves with
 *      - null if no matching report
 *      - { ReportObj }
 */
Report.prototype.reportForDate = function (ymd, role) {
    role = role || 'staff';
    var dfd = GMA.Deferred();
    var self = this;

    // Lets make sure ymd is in format: YYYYMMDD
    // it could be :  "2014-03-11T05:00:00.000Z"
    var parts = ymd.split('T');
    var date = parts[0].replace('-','').replace('-','');

    var typeKey = GMA.responseKey[role].reports;
    var idKey = GMA.responseKey[role].id;

    var servicePath = '?q=gmaservices/gma_[ROLE]Report/searchOwn';
    this.gma.gmaRequest({
        role: role,
        path: servicePath,
        method: 'POST',
        data: {
            nodeId: [ this.nodeId ],
            dateWithin: date
        }
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    })
    .done(function(data, textStatus, res){
        if (data.success) {

            var report = null;

            if (data.data.totalCount > 0) {
                var reportData = data.data[typeKey][0];

                report = new Report({
                    gma: self.gma,
                    role: role,
                    reportId: reportData[idKey],
                    nodeId: reportData.node.nodeId,
                    nodeName: reportData.node.shortName,
                    startDate: reportData.startDate,
                    endDate: reportData.endDate
                });
            }

            dfd.resolve(report);
        }
        else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            dfd.reject(err);
        }
    });


    return dfd;

};



/**
 * @function save
 *
 * cause this report to save any of it's measurement values that have changed.
 *
 * @return jQuery Deferred
 */
Report.prototype.save = function () {
    var dfd = GMA.Deferred();

    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/'+ self.reportId;

    var listMeasurements = [];

    // for each of our Measurements:
    for (var id in this._measurements) {
        var current = this._measurements[id];

        // if it has changed then include it in the update:
        if (current.hasChanged() ) {
            listMeasurements.push(current.getSaveData());
        }
    }

    // there are measurements to update
    if (listMeasurements.length > 0) {

        self.gma.gmaRequest({
            role: self.role,
            noAnimation: true,
            path: servicePath,
            method: 'PUT',
            data: listMeasurements
        })
        .fail(function(res, status, err) {
            dfd.reject(err);
        })
        .done(function(data, status, res) {

            if (data.success) {

                // now update these measurements to know they've been
                // saved.  Halleluia!
                listMeasurements.forEach(function(saveData){
                    var measurement = self._measurements[saveData.measurementId];
                    if (measurement) {
                        measurement.saved();
                    }
                });

                dfd.resolve();
            } else {
                var err = new Error(data.error.errorMessage);
                err.origin = "PUT " + servicePath;
                dfd.reject(err);
            }
        });
    } else {

        // nothing to update, so assume all good!
        dfd.resolve();
    }

    return dfd;
};





/************************************************************************/
/**
 * @class Measurement
 *
 * A measurement is unique to a particular report.
 */
var Measurement = function (data) {
    this.gma = data.gma;
    this.report = data.report;
    this.isDirty = false;  // flag to determine if Measurement needs saving().

    delete data.gma;
    delete data.report;

    var defaults = {
        reportId: 0,
        measurementId: 0,
        measurementName: "Measurement",
        measurementDescription: "This is a GMA measurement",
        measurementValue: 0,
        role: 'staff'
    };
    this.data = GMA.Extend(defaults, data);

    this.timer = null;
    this.pendingDFD = null;
};

Measurement.timeout = 3000; // 3 seconds for delayed save operation



/**
 * @function getReport
 *
 * Return the report this Measurement was pulled from.
 *
 * @return object
 */
Measurement.prototype.getReport = function() {
    return this.report;
};



/**
 * @function getSaveData
 *
 * Return an object describing how to update this measurement value
 * according to the GMA api.
 *
 * @return object
 */
Measurement.prototype.getSaveData = function() {
    return {
                measurementId: this.data.measurementId,
                type: 'numeric',
                value: this.data.measurementValue
            };
};



/**
 * @function hasChanged
 *
 * has the value of this Measurement changed since it was loaded?
 *
 * @return bool
 */
Measurement.prototype.hasChanged = function () {
    return this.isDirty;
};



/**
 * @function id
 *
 * Return the Measurement's id value.
 *
 * @return int
 */
Measurement.prototype.id = function () {
    return this.data.measurementId;
};



/**
 * @function label
 *
 * return the label for this measurement
 *
 * @return string
 */
Measurement.prototype.label = function () {
    return this.data.measurementName;
};



/**
 * @function value
 *
 * Return/set the value of this measurement.
 *
 * @codestart
 * var currValue = measurement.val(); // get the value
 * currValue++;
 * measurement.val(currValue);        // set the value
 * @codeend
 *
 * @param int val   the value to set.
 * @return object
 */
Measurement.prototype.value = function (val) {
    if (typeof val != 'undefined') {
        if (this.data.measurementValue != val)  this.isDirty = true;
        return this.data.measurementValue = val;
    }
    return this.data.measurementValue;
};



/**
 * @function delayedSave
 *
 * Wait a few seconds before saving the measurement value to the server.
 * Any new delayed save operations within that time will replace this one.
 *
 * @return jQuery Deferred
 */
Measurement.prototype.delayedSave = function () {
    var self = this;
    var dfd = GMA.Deferred();

    // Cancel any previous delayed save requests
    if (self.timer) {
        clearTimeout(self.timer);
        self.timer = null;
        // Cancelling is an expected behaviour and not an error
        self.pendingDFD.resolve("Cancelled");
    }

    self.pendingDFD = dfd;
    self.timer = setTimeout(function(){
        // The actual save is done here once the time comes
        self.save()
        .done(function(){
            dfd.resolve();
        })
        .fail(function(err){
            dfd.reject(err);
        });
    }, Measurement.timeout);

    return dfd;
};



/**
 * @function save
 *
 * Save the measurement's value to the server immediately.
 *
 * @return jQuery Deferred
 */
Measurement.prototype.save = function () {
    var dfd = GMA.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/'+ self.data.reportId;

    self.gma.gmaRequest({
        role: self.data.role,
        noAnimation: true,
        path: servicePath,
        method: 'PUT',
        data: [  self.getSaveData() ]
    })
    .fail(function(res, status, err) {
        dfd.reject(err);
    })
    .done(function(data, status, res) {

        if (data.success) {

            // our data is current with GMA
            self.isDirty = false;

            dfd.resolve();
        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = "PUT " + servicePath;
            dfd.reject(err);
        }
    });

    return dfd;
};



/**
 * @function saved
 *
 * If this measurement was saved externally (like Report.save()) this
 * method lets the Measurement know that.
 *
 */
Measurement.prototype.saved = function () {
    this.isDirty = false;
};



/**
 * @function toJSON
 *
 * Return a simple json object representing the Measurement.
 *
 */
Measurement.prototype.toJSON = function () {
    return this.data;
};

