/*
 * node-onlykey-lib, as this app's `okLib` service.
 *
 * The shared OnlyKey client library (node-onlykey-lib) is replacing the
 * in-repo one under src/onlykey-fido2/onlykey/, page by page. A page that has
 * moved asks this service for the library's okcrypto instead of calling
 * app.onlykey3rd(); when no page uses onlykey3rd any more, the old library and
 * its plugin are deleted.
 *
 *   const ok = await app.okLib.okcrypto();   // composed + connected on first use
 *   ok.on('challenge', ({ digits }) => ...); // the three digits to press
 *
 * Composed LAZILY: most page loads never touch the key, and composing is where
 * the WebAuthn transport is created. CONNECTED ONCE per page load
 * (connectTunnel: the plain OKCONNECT that sets the clock and tells the
 * library which firmware it is talking to, and so which transit box to speak);
 * a failed connect is not cached, so the next use tries again - after the key
 * is plugged in, say.
 *
 * What the old library's check() did around the connect, kept here:
 *   - the app events the status icon listens for (ok-connecting,
 *     ok-connected, ok-disconnected);
 *   - the version route (version-route.js): firmware newer than v3.0.4 is
 *     served from apps.onlykey.io, older from apps.crp.to;
 *   - the page's gate before EVERY WebAuthn request (the library's
 *     beforeRequest): Safari's user-gesture step, then document focus.
 */
var versionRoute = require("./version-route.js");

// Longer than a glance away, shorter than the firmware's 20s response wipe.
var FOCUS_WAIT_MS = 15000;

/* Resolves true as soon as the document has focus, false if it does not get
 * it within `budget`. Moved as-is from the old library (onlykey-api.js):
 * WebAuthn does not run on a document without focus, and
 * navigator.credentials.get() there does not reject - it waits, and by the
 * time focus returns the device has wiped the request. So a request is never
 * ISSUED into that state.
 *
 * Both a listener and a poll: a window that regains focus while the tab is
 * already the active one does not always deliver a 'focus' event to the
 * page, and a visibilitychange without focus is not enough - hasFocus() is
 * the condition WebAuthn actually tests, so that is the condition polled. */
function awaitDocumentFocus(window, budget, onWait) {
    var document = window.document;
    if (!document || typeof document.hasFocus !== "function") return Promise.resolve(true);
    if (document.hasFocus()) return Promise.resolve(true);
    if (onWait) onWait();
    return new Promise(function(resolve) {
        var settled = false;
        function finish(ok) {
            if (settled) return;
            settled = true;
            window.removeEventListener("focus", onfocus);
            clearInterval(poll);
            clearTimeout(timer);
            resolve(ok);
        }
        function onfocus() { if (document.hasFocus()) finish(true); }
        window.addEventListener("focus", onfocus);
        var poll = setInterval(onfocus, 250);
        var timer = setTimeout(function() { finish(false); }, budget);
    });
}

module.exports = {
    consumes: ["app", "window"],
    provides: ["okLib"],
    setup: function(options, imports, register) {
        const { startBrowser } = require("node-onlykey-lib/browser");
        const { parseStatus } = require("node-onlykey-lib/device/version");
        const app = imports.app;
        const window = imports.window;

        let started = null;
        let connected = null;

        const okLib = {
            /** The status line from the last connect, and the firmware it names. */
            status: null,
            version: null,

            /**
             * Safari's gate: set by the index page to a function(proceed) that
             * asks the user to click, since Safari runs WebAuthn only from a
             * user gesture. Called before every request while set.
             */
            step: null,

            /** The composed library (a Rectify app); its services are the API. */
            start: function() {
                if (!started) {
                    started = startBrowser({
                        credentials: window.navigator.credentials,
                        beforeRequest: function() {
                            var stepped = okLib.step
                                ? new Promise(function(resolve) { okLib.step(resolve); })
                                : Promise.resolve();
                            return stepped.then(function() {
                                return awaitDocumentFocus(window, FOCUS_WAIT_MS, function() {
                                    app.emit("ok-waiting");
                                });
                            }).then(function(focused) {
                                if (!focused) {
                                    throw new Error("page lost focus - OnlyKey cannot be reached while this tab is in the background");
                                }
                            });
                        },
                    });
                }
                return started;
            },

            /** okcrypto, connected to the key. */
            okcrypto: function() {
                if (!connected) {
                    app.emit("ok-connecting");
                    connected = okLib.start().then(function(lib) {
                        const okcrypto = lib.services.okcrypto;
                        return okcrypto.connectTunnel().then(function(answer) {
                            okLib.status = String(answer.status || "").trim();
                            var info = parseStatus(okLib.status);
                            okLib.version = info.version || null;
                            var route = versionRoute.afterHandshake(window.location, okLib.version);
                            if (route.action === "redirect") {
                                console.info("Version route:", route.reason, "->", route.url);
                                app.emit("ok-disconnected");
                                window.location.replace(route.url);
                                throw new Error(route.reason + ". Taking you there...");
                            }
                            console.info("OnlyKey", okLib.status);
                            app.emit("ok-connected", okLib.version);
                            return okcrypto;
                        });
                    }).catch(function(err) {
                        connected = null;
                        app.emit("ok-disconnected");
                        throw err;
                    });
                }
                return connected;
            },
        };

        /*
         * THE CLASSIC PGP PAGES' VIEW, shaped like the old library's
         * onlykeyApi service so Encrypt and Decrypt moved by one line each:
         *   api    - getKey and getAllUrlParams (app utilities, moved as-is),
         *            connect()/init (this service's connect), and an emitter
         *            the pages listen on;
         *   pgp()  - .api() is a new classic PGP engine (pgp-engine.js), the
         *            old engine's surface on the library's openpgp.
         */
        const EventEmitter = require("events");
        const utils = require("./app-utils.js")(window);
        const createPgpEngine = require("./pgp-engine.js");
        const compatApi = new EventEmitter();
        compatApi.init = false;
        compatApi.getKey = utils.getKey;
        compatApi.getAllUrlParams = utils.getAllUrlParams;
        compatApi.connect = function() {
            return okLib.okcrypto().then(function() {
                compatApi.init = true;
            }).catch(function(err) {
                compatApi.emit("error", err && err.message ? err.message : String(err));
            });
        };
        okLib.onlykeyApi = {
            api: compatApi,
            pgp: function() {
                return {
                    api: function() {
                        return createPgpEngine({ app: app, okLib: okLib, getKey: utils.getKey, window: window });
                    }
                };
            }
        };

        register(null, { okLib: okLib });
    }
};
