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
 * (connectTunnel: the plain OKCONNECT that tells the library which firmware it
 * is talking to, and so which transit box to speak); a failed connect is not
 * cached, so the next use tries again - after the key is plugged in, say.
 */
module.exports = {
    consumes: ["app", "window"],
    provides: ["okLib"],
    setup: function(options, imports, register) {
        const { startBrowser } = require("node-onlykey-lib/browser");

        let started = null;
        let connected = null;

        const okLib = {
            /** The composed library (a Rectify app); its services are the API. */
            start: function() {
                if (!started) {
                    started = startBrowser({ credentials: imports.window.navigator.credentials });
                }
                return started;
            },

            /** okcrypto, connected to the key. */
            okcrypto: function() {
                if (!connected) {
                    connected = okLib.start().then(function(lib) {
                        const okcrypto = lib.services.okcrypto;
                        return okcrypto.connectTunnel().then(function() { return okcrypto; });
                    }).catch(function(err) {
                        connected = null;
                        throw err;
                    });
                }
                return connected;
            },
        };

        register(null, { okLib: okLib });
    }
};
