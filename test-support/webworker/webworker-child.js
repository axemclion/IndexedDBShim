// Launcher script for WebWorkers.
//
// Sets up context and runs a worker script. This is not intended to be
// invoked directly. Rather, it is invoked automatically when constructing a
// new Worker() object.
//
//      usage: node worker.js <sock> <script>
//
//      The <sock> parameter is the filesystem path to a UNIX domain socket
//      that is listening for connections. The <script> parameter is the
//      path to the JavaScript source to be executed as the body of the
//      worker.
if (process.argv.length < 4) {
    throw new Error('usage: node worker.js <sock> <script>');
}
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');
const WebSocket = require('ws');
const wwutil = require('./webworker-util');
// Had problems with npm and the following when requiring `webworkers`
//   as a separate repository (due to indirect circular dependency?);
// const indexeddbshim = require('indexeddbshim');
const indexeddbshim = require('../../'); // '../../dist/indexeddbshim-UnicodeIdentifiers-node.js');
const XMLHttpRequest = require('xmlhttprequest');
// const Worker = require('./webworker'); // Todo: May need to allow workers their own

/*
const permittedProtocols;
try {
    permittedProtocols = JSON.parse(process.argv[6])
} catch (err) {
    throw new Error('There was an error processing the permitted protocols argument (which must be a valid stringified JSON object)');
}
*/

const workerCtx = {};
const sockPath = process.argv[2];
const workerURL = process.argv[3];
const scriptLoc = new wwutil.WorkerLocation(workerURL);
// Connect to the parent process
const ws = new WebSocket('ws+unix://' + sockPath);
const ms = new wwutil.MsgStream(ws);

const workerOptions = {
    type: process.argv[4], // "classic" (default), "module"
    credentials: process.argv[5] // "omit" (if type=module), "include", "same-origin"
};
const workerConfig = {
    node: process.argv[6] === 'true', // Whether to add basic Node globals and require capability to worker
    relativePathType: process.argv[7], // "file", "url" - determines Worker `src` argument interpretation; defaults to "url"
                                        //       relative paths will be relative to `basePath`; absolute paths will be relative to `rootPath`
    basePath: process.argv[8] === 'false' ? false : process.argv[8], // The base path for pathType="url" defaults to `localhost`; the base path for pathType="file"; defaults to the current working directory; if `false`, will throw upon relative paths
    rootPath: process.argv[9],
    origin: process.argv[10] // Used for the `Origin` header (may be `null`); if `*` will cause cross-origin restrictions to be ignored
};

// Catch exceptions
//
// This implements the Runtime Script Errors section fo the Web Workers API
// specification at
//
//  http://www.whatwg.org/specs/web-workers/current-work/#runtime-script-errors
//
// XXX: There are all sorts of pieces of the error handling spec that are not
//      being done correctly. Pick a clause, any clause.
let inErrorHandler = false;

const exceptionHandler = function (e) {
    if (!inErrorHandler && workerCtx.onerror) {
        inErrorHandler = true;
        workerCtx.onerror(e);
        inErrorHandler = false;

        return;
    }

    // Don't bother setting inErrorHandler here, as we're already delivering
    // the event to the master anyway
    ms.send([wwutil.MSGTYPE_ERROR, {
        'message': wwutil.getErrorMessage(e),
        'filename': wwutil.getErrorFilename(e),
        'lineno': wwutil.getErrorLine(e),
        'stack': e.stack
    }]);
};

// Message handling function for messages from the master
const handleMessage = function (msg, fd) {
    if (!wwutil.isValidMessage(msg)) {
        wwutil.debug('Received invalid message: ' + util.inspect(msg));
        return;
    }

    switch (msg[0]) {
    case wwutil.MSGTYPE_NOOP:
        break;

    case wwutil.MSGTYPE_CLOSE:
        // Conform to the Web Workers API for termination
        workerCtx.closing = true;

        // Close down the event sources that we know about
        ws.close();

        // Request that the worker perform any application-level shutdown
        if (workerCtx.onclose) {
            workerCtx.onclose();
        }

        break;

    case wwutil.MSGTYPE_USER:
        // XXX: I have no idea what the event object here should really look
        //      like. I do know that it needs a 'data' elements, though.
        if (workerCtx.onmessage || workerCtx.eventHandlers['message'].length > 0) {
            const e = { data: msg[1] };

            if (fd) {
                e.fd = fd;
            }

            if (workerCtx.onmessage) {
                workerCtx.onmessage(e);
            }

            for (let i = 0; i < workerCtx.eventHandlers['message'].length; i++) {
                workerCtx.eventHandlers['message'][i](e);
            }
        }

        break;

    default:
        wwutil.debug('Received unexpected message: ' + util.inspect(msg));
        break;
    }
};

// Set up the context for the worker instance
let workerCtxObj; // eslint-disable-line prefer-const
let scriptSource;

// Once we connect successfully, set up the rest of the world
ws.addListener('open', function () {
    // When we receive a message from the master, react and possibly
    // dispatch it to the worker context
    ms.addListener('msg', handleMessage);

    // Register for uncaught events for delivery to workerCtx.onerror
    process.addListener('uncaughtException', exceptionHandler);

    // Execute the worker
    vm.runInContext(scriptSource, workerCtxObj);
});

// Per https://fetch.spec.whatwg.org/#cors-protocol-and-credentials
//    Following response headers:
//        `Access-Control-Allow-Origin`=[Submitted `Origin` including possibly `null`] or `*`
//        `Access-Control-Allow-Credentials`=`true`/undefined
//    ...if credentials=omit (which needs type=module); if 1st header not malformed, share (otherwise don't share)
//    ...if credentials=include; if 1st header is not `*` AND 2nd header is present and not malformed, share (otherwise don't share)
//    ...if credentials=same-origin; only share if same origin (no prior preflight (which is always omit) needed or follow include share requirements?)
//    Should be following credentials flag also:
//        credentials flag = credentials=include or credentials=same-origin & response-tainting=basic (not cors or opaque)
// See also https://html.spec.whatwg.org/multipage/webappapis.html#fetch-a-module-worker-script-tree

/*
const workerOptions = {
    type: process.argv[4], // "classic" (default), "module"
    credentials: process.argv[5] // "omit" (if type=module), "include", "same-origin"
};
const workerConfig = {
    node: process.argv[6] === 'true', // Whether to add basic Node globals and require capability to worker
    relativePathType: process.argv[7], // "file", "url" - determines Worker `src` argument interpretation; defaults to "url"
                                        //       relative paths will be relative to `basePath`
    basePath: process.argv[8], // The base path for pathType="url" defaults to `localhost`; the base path for pathType="file" defaults to the current working directory; if `false`, will throw upon relative paths
    rootPath: process.argv[9],
    origin: process.argv[10] // Used for the `Origin` header (may be `null`); if `*` will cause cross-origin restrictions to be ignored
};
*/

// Construct the Script object to host the worker's code
switch (scriptLoc.protocol) {
case 'file':
    scriptSource = fs.readFileSync(scriptLoc.pathname);
    break;

default:
    console.error('Cannot load script from unknown protocol \'' +
        scriptLoc.protocol);
    process.exit(1);
}

// Context elements required for node.js
//
// Todo: How to allow user to customize configuration here????
if (workerConfig.node) {
    workerCtx.global = workerCtx;
    workerCtx.process = process;
    workerCtx.require = require;
    workerCtx.__filename = scriptLoc.pathname;
    workerCtx.__dirname = path.dirname(scriptLoc.pathname);
}
// XXX: There must be a better way to do this.
workerCtx.console = console;
workerCtx.setTimeout = setTimeout;
workerCtx.clearTimeout = clearTimeout;
workerCtx.setInterval = setInterval;
workerCtx.clearInterval = clearInterval;
workerCtx.Buffer = Buffer;
workerCtx.ArrayBuffer = ArrayBuffer;
workerCtx.DataView = DataView;
workerCtx.Int8Array = Int8Array;
workerCtx.Int16Array = Int16Array;
workerCtx.Int32Array = Int32Array;
workerCtx.Uint8Array = Uint8Array;
workerCtx.Uint16Array = Uint16Array;
workerCtx.Uint32Array = Uint32Array;
workerCtx.Float32Array = Float32Array;
workerCtx.Float64Array = Float64Array;

indexeddbshim(workerCtx); // Add indexedDB globals
workerCtx.XMLHttpRequest = XMLHttpRequest({basePath: workerConfig.basePath});

// Context elements required by the WebWorkers API spec
workerCtx.postMessage = function (msg) {
    ms.send([wwutil.MSGTYPE_USER, msg]);
};
workerCtx.self = workerCtx;
workerCtx.WorkerGlobalScope = workerCtx;

// Todo: In place of this, allow conditionally `SharedWorkerGlobalScope`, or `ServiceWorkerGlobalScope`
workerCtx.DedicatedWorkerGlobalScope = workerCtx;
// This was needed for testharness' `instanceof` check which requires it to be callable: `self instanceof DedicatedWorkerGlobalScope`
workerCtx.DedicatedWorkerGlobalScope[Symbol.hasInstance] = function (inst) { return true; };

workerCtx.location = scriptLoc;
workerCtx.closing = false;
workerCtx.close = function () {
    process.exit(0);
};
workerCtx.eventHandlers = {message: []};
workerCtx.addEventListener = function (event, handler) {
    if (event in workerCtx.eventHandlers) {
        workerCtx.eventHandlers[event].push(handler);
    }
};
workerCtx.importScripts = function () {
    if (workerOptions.type === 'module') {
        // https://html.spec.whatwg.org/multipage/workers.html#importing-scripts-and-libraries
        throw new TypeError('For modules, `importScripts` should not be used. Use `import` statements instead.');
    }
    // Todo: Support URL/absolute file paths
    for (let i = 0; i < arguments.length; i++) {
        // Todo: Handle pathType="url" (defaults to `localhost`) and if basePath is `false` with it
        const currentPath = (/^[\\/]/).test(arguments[i]) // Root
                    ? workerConfig.pathType === 'file' && workerConfig.basePath === false ? process.cwd() : workerConfig.rootPath
                    : workerConfig.pathType === 'file' && workerConfig.basePath === false ? process.cwd() : workerConfig.basePath;
        /*
        console.log(path.join(
            currentPath,
            arguments[i]
        ));
        */
        try {
            vm.runInContext(
                fs.readFileSync(
                    path.join(
                        currentPath,
                        arguments[i]
                    )
                ),
                workerCtxObj
            );
        } catch (err) {
            console.log(err);
            throw err;
        }
    }
};

// Context object for vm script api
workerCtxObj = vm.createContext(workerCtx);