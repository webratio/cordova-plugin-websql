
/*
 * Copyright (c) Microsoft Open Technologies, Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 */

/*global require, module*/

var exec = require('cordova/exec'),
    SqlTransaction = require('./SqlTransaction');

var READONLY = true;
var READWRITE = false;

var Database = function (name, version, displayName, estimatedSize, creationCallback) {
    // // Database openDatabase(in DOMString name, in DOMString version, in DOMString displayName, in unsigned long estimatedSize, in optional DatabaseCallback creationCallback
    // TODO: duplicate native error messages
    if (!name) {
        throw new Error('Database name can\'t be null or empty');
    }
    this.name = name;

    // This is due to SQLite limitation which uses integer version type
    // (websql spec uses strings so you can use “1.3-dev2” for example)
    if (version === 0 || version === "") {
        this.version = 0;
    } else {
        this.version = parseInt(version, 10);
        if (isNaN(this.version)) {
            throw new Error("Datavase version should be a number or its string representation");
        }
    }

    this.displayName = displayName; // not supported
    this.estimatedSize = estimatedSize; // not supported

    this.lastTransactionId = 0;
    this.tasksQueue = [];
    this.tasksRunned = false;

    this.Log('new Database(); name = ' + name);

    var that = this;
    var failed = false;
    var fail = function(err) {
        that.Log('Database.open() err = ' + JSON.stringify(err));
    };

    function callback() {

        // try to get verfion for existing database
        exec(function (actualVersion) {
            if (that.version == 0 || that.version == actualVersion) {
                // If we don't care of DB version or versions are matching
                // then set current version to actual
                that.version = actualVersion;
            } else if (actualVersion == 0) {
                // If actual version is 0, that means that database is just created
                // or it's version hadn't been set yet. In this case we're update it's version to version, provided by user
                exec(null, fail, "WebSql", "setVersion", [that.name, that.version]);
            } else {
                // Otherwise fail with version mismatch error
                failed = actualVersion;
            }
        }, fail, "WebSql", "getVersion", [that.name]);

        // On windows proxy.getVersion method is sync, so the following
        // conditional statement will be executed only after return from exec's success callback

        if (!failed) {
            // We'll schedule a creation callback invocation only if there is no version mismatch
            if(creationCallback) { setTimeout(creationCallback.bind(null, that), 0); }
        }
    }

    exec(callback, fail, "WebSql", "open", [this.name]);

    if (failed) {
        throw new Error("Unable to open database, version mismatch, " + that.version + " does not match the currentVersion of " + failed);
    }
};

Database.prototype.Log = function (text) {
    if(window.__webSqlDebugModeOn === true)
        console.log('[Database] name: ' + this.name + ', tasksQueue.length: ' + this.tasksQueue.length + '. | ' + text);
};

Database.prototype.guid = (function () {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
                   .toString(16)
                   .substring(1);
    }
    return function () {
        return s4() + '' + s4() + '' + s4() + '' + s4() + '' +
               s4() + '' + s4() + '' + s4() + '' + s4();
    };
})();

Database.prototype._transaction = function (cb, onError, onSuccess, preflight, postflight, readOnly, parentTransaction) {
    this.Log('transaction');

    if (typeof cb !== "function") {
        this.Log('transaction callback expected');
        throw new Error("transaction callback expected");
    }

    if (!readOnly) {
        readOnly = READWRITE;
    }

    var me = this;
    var isRoot = !parentTransaction;

    this.transactionSuccess = function () {
        if (onSuccess) {
            onSuccess();
        }
        me.runNext();
    };

    this.transactionError = function (tx, lastError) {
        if (onError) {
            onError(tx, lastError);
        }
        me.runNext();
    };

    this.runNext = function () {
        if (me.tasksQueue.length > 0) {
            var taskForRun = me.tasksQueue.shift();
            taskForRun.task.apply(me, taskForRun.params);
        } else {
            me.tasksRunned = false;
        }
    };

    this.pushTask = function (task) {
        me.tasksQueue.push({
            task: task,
            params: []
        });
        if (!me.tasksRunned) {
            me.tasksRunned = true;
            me.runNext();
        }
    };

    me.lastTransactionId = me.guid();
    var tx = new SqlTransaction(me.transactionError, me.transactionSuccess, postflight, readOnly, me.lastTransactionId, isRoot);

    var runTransaction = function() {
        try {
            var connectionSuccess = function(res) {
                me.Log('transaction.run.connectionSuccess, res.connectionId: ' + res.connectionId);
                if (!res.connectionId) {
                    throw new Error('Could not establish DB connection');
                }
                tx.connectionId = res.connectionId;
                try {
                    var executeTransaction = function() {
                        me.Log('transaction.run.connectionSuccess, executeTransaction');
                        if (preflight) {
                            preflight();
                        }
                        try {
                            cb(tx);
                            if (!tx.transactionStarted) {
                                tx.statementCompleted();
                            }
                        } catch (cbEx) {
                            me.Log('transaction.run.connectionSuccess, executeTransaction callback error: ' + JSON.stringify(cbEx));
                            me.transactionError(tx, cbEx);
                        }
                    };
                    var internalError = function(tx, err) {
                        me.Log('transaction.run.connectionSuccess, internalError: ' + JSON.stringify(err));
                        me.transactionError(tx, err);
                    };
                    exec(executeTransaction, internalError, "WebSql", "executeSql", [tx.connectionId, 'SAVEPOINT trx' + tx.id, []]);
                } catch (ex) {
                    me.Log('transaction.run exception: ' + JSON.stringify(ex));
                    throw ex;
                }
            };

            if (!parentTransaction) {
                me.Log('transaction.run connect to dbName: ' + me.name);
                exec(function (res) {
                    me.Log('transaction.run connect success: ' + JSON.stringify(res));
                    connectionSuccess(res);
                }, function(ex) {
                    me.Log('transaction.run connect error: ' + JSON.stringify(ex));
                }, "WebSql", "connect", [me.name]);
            } else {
                me.Log('transaction.run using parent connectionId: ' + parentTransaction.connectionId);
                connectionSuccess({ connectionId: parentTransaction.connectionId });
            }
        } catch (ex) {
            me.Log('transaction.run DB connection error: ' + JSON.stringify(ex));
            throw ex;
        }
    };

    if (!isRoot) {
        me.Log('transaction pushing as nested');
        parentTransaction.pushTransaction(tx, cb, onError, onSuccess, preflight, postflight, readOnly, parentTransaction);
    } else {
        me.Log('transaction pushing as root');
        this.pushTask(runTransaction);
    }
};

Database.prototype.transaction = function (cb, onError, onSuccess, preflight, postflight, parentTransaction) {
    this._transaction(cb, onError, onSuccess, preflight, postflight, READWRITE, parentTransaction);
};

Database.prototype.readTransaction = function (cb, onError, onSuccess, preflight, postflight, parentTransaction) {
    this._transaction(cb, onError, onSuccess, preflight, postflight, READONLY, parentTransaction);
};

Database.prototype.changeVersion = function (oldVersion, newVersion, cb, onError, onSuccess, parentTransaction) {

    var transaction;
    var that = this;
    var oldver = oldVersion === "" ? 0 : parseInt(oldVersion, 10);
    var newVer = newVersion === "" ? 0 : parseInt(newVersion, 10);

    if (isNaN(oldver) || isNaN(newVer)) {
        throw new Error("Version parameters should be valid integers or its' string representation");
    }

    var callback = function (tx) {
        // Just save a transaction here so we can use it later in postflight
        transaction = tx;
        cb(tx);
    };

    var preflight = function() {
        if (oldver != that.version) {
            throw new Error("Version mismatch. First param to changeVersion is not equal to current database version");
        }
    };

    var postflight = function() {
        transaction.executeSql('PRAGMA user_version=' + newVer, null, function () {
            that.version = newVer === 0 ? "" : String(newVer);
        }, function() {
            throw new Error("Failed to set database version");
        });
    };

    this._transaction(callback, onError, onSuccess, preflight, postflight, READWRITE, parentTransaction);
};

module.exports = Database;
