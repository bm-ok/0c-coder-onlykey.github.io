//change   _template_  to your plugin name

// Two routes, not one. The old single "age-derive" page carried the encrypt
// and decrypt halves stacked on top of each other; they are now the AGE mode
// of the Encrypt page and the AGE mode of the Decrypt page respectively.
//
// No icon and no title on either: app-src.html renders a header link only for
// entries that have one, so these still get their own /app/<name>.html and
// their own route, but the top nav stays Encrypt | Decrypt | Search. The
// selector rendered by mode-tabs.js is how you reach them.
//
// NOTE: /app/age-derive.html is gone. Anything pointing at it - test briefs,
// bookmarks - wants /app/age-encrypt.html or /app/age-decrypt.html now.
var pagesList = {
    "age-encrypt": {
        sort: 34
    },
    "age-decrypt": {
        sort: 35
    }
};

function b64ToBytes(b64) {
    var bin = atob(b64.trim());
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

module.exports = {
    pagesList: pagesList,
    consumes: ["app", "okLib"],
    provides: ["plugin_age-derive"],
    setup: function(options, imports, register) {

        // Deferred to setup-call time, not module-require time - matching
        // the ./age-*.page.html requires at the bottom. webpack.config.js's
        // getPagesList() requires this whole plugin module directly under
        // plain Node (to read pagesList before any bundling happens), which
        // has no knowledge of the @noble/* resolve.alias entries webpack
        // itself uses - a top-level require() of age_pqc.js/age_file.js
        // there would throw MODULE_NOT_FOUND before webpack ever runs.
        var init = false;
        // ON node-onlykey-lib (the shared library) - the first page moved off
        // the in-repo one. The age format, the X-Wing encapsulation and the
        // device decap all come from the library; nothing here does crypto.
        var okCrypto = require("node-onlykey-lib/crypto");
        var modeTabs = require("../pages/mode-tabs.js");
        var page = {
            init: function(app, $page, pathname) {
                init = true;

                page.setup(app, $page, pathname);
            },
            setup: function(app, $page, pathname) {
                if (!init)
                    return page.init(app, $page, pathname);

                var okLib = app.okLib;
                var $ = app.$;

                // THE CHALLENGE CODE comes from the library, computed from the
                // same bytes the device hashes, and is emitted before the
                // request goes out. Deriving a public key never needs one; the
                // decap always does (the device enforces that itself). The box
                // is cleared when an operation ends, so it only ever shows the
                // code for the request in front of the user.
                function showChallenge(digits) {
                    var box = document.getElementById("challenge_code_box");
                    var out = document.getElementById("challenge_code");
                    if (!box || !out) return;
                    if (digits && digits.length) {
                        out.textContent = digits.join("  ");
                        box.style.display = "block";
                    } else {
                        box.style.display = "none";
                    }
                }

                // The library, connected to the key - composed and connected on
                // first use (see src/onlykey-lib/plugin.js). The challenge
                // listener goes on once per connected okcrypto.
                var listening = null;
                function device() {
                    return okLib.okcrypto().then(function(ok) {
                        if (listening !== ok) {
                            listening = ok;
                            ok.on("challenge", function(e) { showChallenge(e && e.digits); });
                        }
                        return ok;
                    });
                }

                function errorText(err) {
                    return "ERROR: " + (err && err.message ? err.message : err);
                }

                function currentLabel() {
                    return $("#label").val();
                }

                $("#label").on("input", function() {
                    var label = currentLabel();
                    $("#identity_out").val(label ? okCrypto.pqc.encodeIdentity(label) : "");
                });

                $("#encrypt_start").click(function() {
                    var label = currentLabel();
                    var plaintext = $("#plaintext").val();
                    $("#age_file_out").val("");
                    // The recipient is the whole 1216-byte X-Wing public key the
                    // device derives for this label; encrypting to it needs no
                    // device at all.
                    device().then(function(ok) {
                        return ok.deviceAge.identity(label).then(function(id) {
                            var fileBytes = ok.deviceAge.encrypt(new TextEncoder().encode(plaintext), id.recipient);
                            $("#age_file_out").val(bytesToB64(fileBytes));
                            $("#identity_out").val(okCrypto.pqc.encodeIdentity(label));
                        });
                    }).catch(function(err) {
                        $("#age_file_out").val(errorText(err));
                    }).finally(function() {
                        showChallenge([]);
                    });
                });

                $("#decrypt_start").click(function() {
                    var label = currentLabel();
                    $("#decrypted_out").val("");
                    var fileBytes;
                    try {
                        fileBytes = b64ToBytes($("#decrypt_file_in").val());
                    } catch (e) {
                        $("#decrypted_out").val("ERROR: invalid base64: " + e.message);
                        return;
                    }
                    // One call: the library parses the file, sends the X-Wing
                    // ciphertext to the device for the label's key, and opens
                    // the file with the shared secret that comes back.
                    device().then(function(ok) {
                        return ok.deviceAge.decrypt(fileBytes, label);
                    }).then(function(plaintextBytes) {
                        $("#decrypted_out").val(new TextDecoder().decode(plaintextBytes));
                    }).catch(function(err) {
                        $("#decrypted_out").val(errorText(err));
                    }).finally(function() {
                        showChallenge([]);
                    });
                });
            }
        };

        // One setup for both routes. Every handler binds by id through jQuery,
        // and a selector that matches nothing binds nothing, so the encrypt
        // view simply never wires #decrypt_start and vice versa. The crypto
        // paths are byte-for-byte the ones the hardware brief exercised - the
        // split is in the markup, not in the handlers.
        pagesList["age-encrypt"] = {
            view: modeTabs("encrypt", "age-encrypt") +
                require("./age-encrypt.page.html").default,
            init: page.init,
            setup: page.setup
        };

        pagesList["age-decrypt"] = {
            view: modeTabs("decrypt", "age-decrypt") +
                require("./age-decrypt.page.html").default,
            init: page.init,
            setup: page.setup
        };

        register(null, {
            "plugin_age-derive": {
                pagesList: pagesList
            }
        });

    }
};
