/************************************************************************/
/**
 * @class GMA
 * Joshua Chan <joshua@appdevdesigns.net>
 *
 *  Dependencies:
 *    - jQuery
 *    - async
 */

var GMA = function (opts) {
    var defaults = {
        gmaBase: 'http://gma.example.com/',
        casURL: 'https://signin.example.com/cas',
        showBusyAnim: function() {},
        hideBusyAnim: function() {},
        reloginCallback: null
    };
    this.opts = $.extend(defaults, opts);

    this.isLoggedIn = false;
    this.renId = null;
    this.GUID = null;
    this.isLoading = 0;
    this.jar = false;
    this.tokenCSRF = '';

    // on node, we need to track our own cookie jar:
    if (typeof module != 'undefined' && module.exports) {
        this.jar = require('request').jar();
    }
};



if (typeof module != 'undefined' && module.exports) {
    // Node.js
    module.exports = GMA;
    var async = require('async');
    var $ = require('node-jquery');
    var $ajax = require('./$ajax.js');
} else {
    // Browser / webview
    window.GMA = GMA;
    $ajax = $.ajax;
}



/**
 * Wrapper for jQuery.ajax(), used internally
 */
GMA.prototype.request = function (opts) {
    if (!opts.noAnimation) {
        this.opts.showBusyAnim();
        this.isLoading += 1;
    }

    var self = this;
    var dfd = $.Deferred();

    var isParseError = function (err) {
        if (!err || !err.message) {
            return false;
        }
        if (err.message.match(/parse error|unexpected end of input|parse.+?unexpected/i)) {
            return true;
        }
        return false;
    };


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

    // pass in our local cookie jar if it exists
    if (this.jar) {
        reqParams.jar = this.jar;
    }

//console.log(reqParams);

    $ajax(reqParams)
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
                .then(function(){
                    // Resend the request
                    self.request(opts)
                    .then(function(res, status, err){
                        dfd.resolve(res, status, err);
                    });
                })
                .fail(function(err){
                    console.log("Relogin failed", err);
                });
            } else {
                // Deliver a hopefully more helpful error
                console.log("Session timeout?", err);
                dfd.reject(res, status, new Error("Login session timed out"));
            }
        }
        else {
            dfd.reject(res, status, err);
        }
    })
    .then(function(data, status, res){
        dfd.resolve(data, status, res);
    });

    return dfd;
};


GMA.clearCookies = function () {
    if (typeof document == 'undefined') return;

    var cookie = document.cookie.split(';');
    for (var i = 0; i < cookie.length; i++) {
        var chip = cookie[i],
            entry = chip.split("="),
            name = entry[0];
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    }
};



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
    var tgt;
    var st;
    var dfd = $.Deferred();
    var self = this;
    //var gmaHome = self.opts.gmaBase + '?q=node';
    //var gmaHome = self.opts.gmaBase + 'index.php?q=en/node';
    var gmaHome = self.opts.gmaBase + '?q=en/node&destination=node';
    //var gmaHome = self.opts.gmaBase + '?q=gmaservices&destination=gmaservices';

    self.opts.showBusyAnim();
    GMA.clearCookies();
    async.series([

        // Step 0: Make sure we are not already logged in
        function(next){
            if (self.isLoggedIn) {
                console.log("Logging out first to reset session");
                self.logout()
                .then(function(){ next(); });
            } else {
                next();
            }
        },
        // Step 1: Get the TGT
        function(next){

            var reqParams = {
                url: self.opts.casURL + "/v1/tickets",
                type: "POST",
                cache: false,
                data: { username: username, password: password }
            };
            if (self.jar) reqParams.jar = self.jar;

            $ajax(reqParams)
            .then(function(data, textStatus, res){
                tgt = res.getResponseHeader('Location');
                if (tgt) {
                    next();
                } else {
                    console.log(data, textStatus, res);
                    next(new Error('Credentials were not accepted'));
                }
            })
            .fail(function(res, textStatus, err){
                //console.log(res, err);
                if (err instanceof Error) {
                    if (!err.message) {
                        err.message = "[" + textStatus + ": " + res.status + "]";
                    }
                    next(err);
                } else {
                    var message = 'Unexpected result from login server';
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
                data: { service: gmaHome }
            };
            if (self.jar) reqParams.jar = self.jar;

            $ajax(reqParams)
            .then(function(data, textStatus, res){
                // Credentials verified by CAS server. We now have the
                // service ticket.
                st = data;
                next();
            })
            .fail(function(res, textStatus, err){
                next(err);
            });
        },
        // Step 3: Log in to GMA
        function(next){
            var finalURL = gmaHome +
                (gmaHome.match(/[?]/) ? "&" : '?') +
                "ticket=" + st;

            var reqParams = {
                url: finalURL,
                type: "GET"
            };
            if (self.jar) reqParams.jar = self.jar;

            $ajax(reqParams)
            .then(function(data, textStatus, res){
                if (data.match(/CAS Authentication failed/)) {
                    // Authentication problem on the Drupal site
                    next(new Error("Sorry, there was a problem authenticating with the server"));
                } else {
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
        // Step 4: Fetch the Drupal CSRF token
        function(next){
            var reqParams = {
                url: self.opts.gmaBase + '?q=services/session/token',
                type: "GET"
            };
            
            $ajax(reqParams)
            .done(function(data, textStatus, res){
                self.tokenCSRF = data;
                next();
            })
            .fail(function(res, textStatus, err){
                console.log('Unable to get CSRF token');
                console.log(err);
                // Don't fail on this error in case we are on Drupal 6
                // instead of Drupal 7.
                next(); 
            });
        },
        // Step 5: Get user info
        function(next){
            self.getUser()
            .then(function(){ next(); })
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
 * @function loginManila
 *
 * Temporary testing login to use on the test GMA server at Manila conference.
 *
 * @param string username
 * @param string password
 * @return jQuery Deferred
 */
GMA.prototype.loginDrupal = function (username, password) {
    var dfd = $.Deferred();
    var self = this;
    var canSkipLogin = false;

    console.log('in gma.loginDrupal() ...');

    self.opts.showBusyAnim();
    GMA.clearCookies();
    // This is the form info submitted from a Drupal login page:
    /*
        form_build_id   form-oJvHA2khmwGCNaARkbsUN_AYVYYsAKG0O8O7B9BJz5k
        form_id user_login
        name    mark.griffen@ccci.org
        op  Log in
        pass    manila
    */
    async.series([

        //Step 0: Make sure we are not already logged in
        function(next){
            if (self.isLoggedIn) {
                console.log("Logging out first to reset session");
                self.logout()
                .then(function(){ next(); });
            } else {
                next();
            }
        },


        //Step 1: Attempt to get current user info ...
        function(next){

//console.log('   gma.loginDrupal() : step 1: attempting to getUser() ... ');
            self.getUser()
            .then(function(){
                next();
                canSkipLogin = true;
            })
            .fail(function(err){
//console.log('   error in gma.loginDrupal():step 1:.getUser():');
//console.log(err);

                // an error here could simply mean drupal didn't like our login
                // credentials.  So we continue on...
                next();
            });

        },

        //Step 4: Submit Login Info
        function(next){
            if (canSkipLogin) {
//console.log('   gma.loginDrupal() : step 4: can skip login ... ');
                next();
            } else {
//console.log('   gma.loginDrupal() : step 4: MUST login ... ');

                var loginData = {
                        name:username,
                        pass:password,
                        op:'Log in',
                        form_id:'user_login'
                };
                $ajax({
                    url: self.opts.gmaBase+'?q=user/login',
                    type: "POST",
                    data: loginData,

                })
//                self.request({
//                    path: self.opts.gmaBase+'?q=user/login',
//                    method: 'POST',
//                    data:loginData
//                })
                .fail(function(res, textStatus, err){
//console.log();
//console.error('----------------');
//console.error('  *** gma.loginDrupal() : step 4: $ajax(user/login) failed: ');
//console.log(res);
//console.log(textStatus);
//console.log(res.getAllHeaders());
//console.log(res.getResponseHeader());

                    next(err);
                })
                .then(function(data, textStatus, res){
                    // Credentials verified by Drupal.
//console.log();
//console.log('---------');
//console.log('   gma.loginDrupal() : step 4: $ajax(user/login) success: ');
//console.log(res);
//console.log(textStatus);
//console.log(res.getAllHeaders());
                    // now ask GMA for who we are:
                    self.getUser()
                    .then(function(){ next(); })
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

                });

            }

        } // end fn() drupalLogin

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
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_user&type=current';

    self.request({
        path: servicePath,
        method: 'GET'
    })
    .then(function(data, textStatus, res){
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
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    });

    return dfd;
};



/**
 * @function getAssignments
 *
 * Delivers the GMA nodes that the user is assigned to.
 *
 * @return jQuery Deferred
 *      resolves with three parameters
 *      - assignmentsByID { 101: "Assign1", 120: "Assign2", ... }
 *      - assignmentsByName { "Assign1": 101, "Assign2": 120, ... }
 *      - listAssignments [ { AssignmentObj1 }, { AssignmentObj2 }, ... ]
 */
GMA.prototype.getAssignments = function () {
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_user/' + self.renId + '/assignments/staff';

    self.request({
        path: servicePath,
        method: 'GET'
    })
    .then(function(data, textStatus, res){
        if (data.success) {
            // Create two basic lookup objects indexed by nodeId and by name
            var assignmentsByID = {};
            var assignmentsByName = {};
            var listAssignments = [];
//console.log('gma returned staff assignments:');
//console.log(data.data.staff);
            if (data.data['staff']) {
                for (var i=0; i<data.data.staff.length; i++) {
                    var nodeId = data.data.staff[i].nodeId;
                    var shortName = data.data.staff[i].shortName;
                    assignmentsByID[nodeId] = shortName;
                    assignmentsByName[shortName] = nodeId;

                    listAssignments.push(new Assignment({
                        gma:self,
                        nodeId:nodeId,
                        shortName:shortName
                    }));
                }
            }
            dfd.resolve(assignmentsByID, assignmentsByName, listAssignments);
        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            dfd.reject(err);
            console.log(data);
        }
    })
    .fail(function(res, textStatus, err){
        dfd.reject(err);
    });

    return dfd;
};



/**
 * @function getReportsForNode
 *
 * Delivers an array of up to ten Report objects for reports within
 * the specified node.
 *
 * @param int nodeId
 * @return jQuery Deferred
 *      resolves with :
 *      - []  if no report found
 *      - [ {ReportObj1}, {ReportObj2}, ... ]
 */
GMA.prototype.getReportsForNode = function (nodeId) {
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_staffReport/searchOwn';
//console.log('   getReportsForNode():  nodeId['+nodeId+']');
    self.request({
        path: servicePath,
        method: 'POST',
        data: {
            nodeId: [nodeId],
            maxResult: 10
            //submitted: false
        }
    })
    .then(function(data, textStatus, res){
//console.log('request completed for nodeId['+nodeId+']:');
//console.log(data);
//console.log(data.data.staffReports);
//console.log(res);

        if (data.success) {
//console.log('data.successful ...');

            if (!data.data.staffReports) {
//console.log('   don\'t think there are any reports ...');

                // so return an empty array:
                dfd.resolve([]);
            }
            else {
//console.log('   compiling reports ...');

                var reports = [];
                for (var i=0; i<data.data.staffReports.length; i++) {

                    // NOTE: it's possible the web service wont actually filter
                    // based on the given nodeId (I've seen it), so we need to
                    // verify which reports belong to this nodeId:

                    // if this report belongs to this nodeId
                    if (nodeId == data.data.staffReports[i].node.nodeId) {

                        var reportId = data.data.staffReports[i].staffReportId;
                        var nodeName = data.data.staffReports[i].node.shortName;
                        reports.unshift(new Report({
                            gma: self,
                            reportId: reportId,
                            nodeId: data.data.staffReports[i].node.nodeId,
                            nodeName: nodeName,
                            startDate: data.data.staffReports[i].startDate,
                            endDate: data.data.staffReports[i].endDate
                        }));
                    }
                }
                dfd.resolve(reports);
            }

        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = servicePath;
            console.log(data);
            dfd.reject(err);
        }
    })
    .fail(function(res, textStatus, err){

//console.log(' shoot! error getting reports...');
//console.log(res.getAllHeaders());
//console.log(res);
//console.log(err);

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
    var dfd = $.Deferred();
    var self = this;

    self.request({
        path: '?q=logout',
        method: 'HEAD',
        dataType: 'html'
    })
    .then(function(){
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

};



/**
 * @function getMeasurements
 *
 * lookup a list of Measurements associated with this Assignment.
 *
 * @return jQuery Deferred
 *      resolves with
 *      - []  if no Measurements found
 *      - [{MeasurementObj1}, {MeasurementObj2}, ... ]
 */
Assignment.prototype.getMeasurements = function () {
    var dfd = $.Deferred();
//    var self = this;
//console.log('------------');
//console.log('Assignment.getMeasurements('+this.nodeId+'):');

    this.gma.getReportsForNode(this.nodeId)
    .fail(function(err){
        console.error('  *** Assignemnt.getMeasurement() error finding reports...');
        dfd.reject(err);
    })
    .then(function(listReports) {
//console.log('got this for listReports:');
//console.log(listReports);

        if (listReports.length == 0) {
            console.warn('  --- Assignment.getMeasurements():  no reports returned ... ');
            // no measurements for this assignment...
            dfd.resolve([]);

        } else {
//console.log('Assignment.getMeasurements():  '+ listReports.length +' reports returned ... ');
//console.log(listReports[0]);

            listReports[0].measurements()
            .fail(function(err){
                console.error('  *** Assignment.getMeasurements(): report.measurement()  had and error:');
                console.log(err);
                dfd.reject(err);
            })
            .then(function(list){
//console.log();
//console.log('Assignment.getMeasurements(): report.measurement()  returned these measurements:');
//console.log(list);
		// list = {
        //    'strategyName':[ measurements ],
        //    'strategyName2':[ measuremenList2 ],
        //      ...
        //  }
                // Assumption: We will automatically choose the 1st strategy since
                // in our ministry context it makes since for ren to report on a node
                // with only 1 strategy:
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
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_staffReport/' + self.reportId + '/numeric';

    self.gma.request({
        path: servicePath,
        method: 'GET'
    })
    .then(function(data, textStatus, res) {
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
                            report:self,
                            reportId: self.reportId,
                            measurementId: info.measurementId,
                            measurementName: info.measurementName,
                            measurementDescription: info.measurementDescription,
                            measurementValue: info.measurementValue
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
    })
    .fail(function(res, textStatus, err) {
        dfd.reject(err);
    });

    return dfd;
};



/**
 * @function formatDate
 *
 * return a more readable date string than what is provided from GMA.
 *
 * @param string ymd  the GMA date string
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
    /*
    var dfd = $.Deferred();
    dfd.resolve(this.startDate);
    return dfd;
    */

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
 * @return jQuery Deferred
 *      resolves with
 *      - null if no matching report
 *      - { ReportObj }
 */
Report.prototype.reportForDate = function (ymd) {
    var dfd = $.Deferred();
    var self = this;

//console.log('    . reportForDate():');
    // Lets make sure ymd is in format: YYYYMMDD
    // it could be :  "2014-03-11T05:00:00.000Z"
    var parts = ymd.split('T');
    var date = parts[0].replace('-','').replace('-','');

    var servicePath = '?q=gmaservices/gma_staffReport/searchOwn';
    this.gma.request({
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
    .then(function(data, textStatus, res){
//console.log('    . .then() returned:');
//console.log();
//console.log(data);
//console.log();
        if (data.success) {

            var report = null;

            if (data.data.totalCount > 0) {
                var reportData = data.data.staffReports[0];
//console.log('report :');
//console.log(reportData);

                report = new Report({
                    gma: self.gma,
                    reportId: reportData.staffReportId,
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
    var dfd = $.Deferred();

    var self = this;
    var servicePath = '?q=gmaservices/gma_staffReport/'+ self.reportId;
//console.log('   servicePath:'+servicePath);

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

        self.gma.request({
            noAnimation: true,
            path: servicePath,
            method: 'PUT',
            data: listMeasurements
        })
        .fail(function(res, status, err) {
            dfd.reject(err);
        })
        .then(function(data, status, res) {
//console.log();
//console.log(' report.save().then():');

            if (data.success) {

//console.log('data:');
//console.log(data);
//console.log('res:');
//console.log(res);

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
        measurementValue: 0
    };
    this.data = $.extend(defaults, data);

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
    var dfd = $.Deferred();

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
        .then(function(){
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
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_staffReport/'+ self.data.reportId;

    self.gma.request({
        noAnimation: true,
        path: servicePath,
        method: 'PUT',
        data: [  self.getSaveData() ]
    })
    .then(function(data, status, res) {

        if (data.success) {

            // our data is current with GMA
            self.isDirty = false;

            dfd.resolve();
        } else {
            var err = new Error(data.error.errorMessage);
            err.origin = "PUT " + servicePath;
            dfd.reject(err);
        }
    })
    .fail(function(res, status, err) {
        dfd.reject(err);
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

