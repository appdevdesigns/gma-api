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
 * Wrapper for jQuery.ajax(), used internally when requesting GMA web services
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

    // pass in our local cookie jar if it exists
    if (this.jar) {
        reqParams.jar = this.jar;
    }

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
                .done(function(){
                    // Resend the request
                    self.request(opts)
                    .done(function(res, status, err){
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



GMA.clearCookies = function () {
    if (typeof document == 'undefined') return;
    
    // This does not seem to work very well
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
    var gmaHome = self.opts.gmaBase + '?q=en/node&destination=node';

    self.opts.showBusyAnim();
    GMA.clearCookies();
    async.series([

        // Step 0: Make sure we are not already logged in
        function(next){
            if (self.isLoggedIn) {
                console.log("Logging out first to reset session");
                self.logout()
                .always(function(){ next(); });
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
            .done(function(data, textStatus, res){
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
                data: { service: gmaHome }
            };
            if (self.jar) reqParams.jar = self.jar;

            $ajax(reqParams)
            .done(function(data, textStatus, res){
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
            .done(function(data, textStatus, res){
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
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_user/' + self.renId + '/assignments/[ROLE]';
    var typeKey = GMA.responseKey[role].type;
    
    self.request({
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
            console.log(data);
        }
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
 * @param string role (Optional) 'staff' or 'director'
 * @return jQuery Deferred
 *      resolves with :
 *      - []  if no report found
 *      - [ {ReportObj1}, {ReportObj2}, ... ]
 */
GMA.prototype.getReportsForNode = function (nodeId, role) {
    role = role || 'staff';
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/searchOwn';
    
    var reportKey = GMA.responseKey[role].reports;
    var idKey = GMA.responseKey[role].id;
    
    self.request({
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
            console.log(data);
            dfd.reject(err);
        }
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
    var dfd = $.Deferred();
//    var self = this;
//console.log('------------');
//console.log('Assignment.getMeasurements('+this.nodeId+'):');

    this.gma.getReportsForNode(this.nodeId, role)
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
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/' + self.reportId + '/numeric';
    var role = self.role;

    self.gma.request({
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
    var dfd = $.Deferred();
    var self = this;

    // Lets make sure ymd is in format: YYYYMMDD
    // it could be :  "2014-03-11T05:00:00.000Z"
    var parts = ymd.split('T');
    var date = parts[0].replace('-','').replace('-','');

    var typeKey = GMA.responseKey[role].reports;
    var idKey = GMA.responseKey[role].id;

    var servicePath = '?q=gmaservices/gma_[ROLE]Report/searchOwn';
    this.gma.request({
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
    var dfd = $.Deferred();

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

        self.gma.request({
            role: role,
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
                listMeasurements.forEach(function(measurement){
                    measurement.saved();
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
    var dfd = $.Deferred();
    var self = this;
    var servicePath = '?q=gmaservices/gma_[ROLE]Report/'+ self.data.reportId;

    self.gma.request({
        role: self.role,
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

