/*
 * The classic PGP engine behind the Encrypt and Decrypt pages, on
 * node-onlykey-lib.
 *
 * It replaces src/onlykey-fido2/onlykey/onlykey-pgp.js (kbpgp plus its own
 * device transport) with the library's openpgp fork and its classic-key
 * hardware hooks: openpgp does the PGP, and only the private operations - RSA
 * or ECC sign, RSA decrypt, X25519 ECDH - go to the OnlyKey, through
 * okcrypto.sign/decrypt over the WebAuthn tunnel.
 *
 * SAME SURFACE as the old engine's api(), so the pages did not change: an
 * EventEmitter with startEncryption(recipients, myKey, message, file, cb),
 * startDecryption(sender, myKey, message, file, cb), _$status / _$status_is /
 * _$reset / _$mode / _$mode_is, and the same events ("working", "status",
 * "error", "done", "_status") with the same texts. The pages emit
 * "completed" on it themselves.
 *
 * SAME SLOTS: the device keeps the signing key in slot 2 and the decryption
 * key in slot 1 (RSA), or 102 and 101 (ECC) - chosen, as before, by whether
 * YOUR key's primary key is RSA.
 *
 * Output is openpgp's, and interoperable either way: messages the old engine
 * made still decrypt here, and these decrypt there. Sign Only still produces
 * a signed armored PGP MESSAGE (not cleartext), as before.
 */
var EventEmitter = require("events");
var openpgp = require("node-onlykey-lib/crypto/pgp");
var classic = require("node-onlykey-lib/crypto").classic;
var saveAs = require("file-saver").saveAs;
var JSZip = require("jszip");
var explainDeviceError = require("./device-errors.js").explainDeviceError;

var SIGN_SLOT = 2;
var DECRYPT_SLOT = 1;
var ECC_OFFSET = 100;

/*
 * The okcrypto instances already relaying their challenge code - one listener
 * each - and the engine that asked the device last, which is where the code
 * belongs (the Encrypt and Decrypt pages each hold an engine).
 */
var listening = new WeakSet();
var activeApi = null;

module.exports = function createPgpEngine(deps) {
    var app = deps.app;
    var okLib = deps.okLib;
    var getKey = deps.getKey;
    var document = deps.window.document;

    var _api = new EventEmitter();
    var _status;
    var _mode;

    function _$status(newStatus) {
        if (newStatus) {
            _status = newStatus;
            _api.emit("_status", newStatus);
        }
        return _status;
    }
    function _$status_is(check) { return !!(_$status() == check); }
    /* Back out of 'finished' so the next click runs again - see the old engine's note. */
    function _$reset() { _status = undefined; _api.emit("_status", undefined); }
    function _$mode(newMode) {
        if (newMode) { _mode = newMode; console.info("PGP mode set to", newMode); }
        return _mode;
    }
    function _$mode_is(check) { return !!(_$mode() == check); }

    function errorText(err) { return explainDeviceError(err && err.message ? err.message : String(err)); }

    /* A key field: pasted armored text, or something getKey can fetch. */
    function resolveKey(value) {
        if (!value) return Promise.resolve(false);
        if (value.slice(0, 10) == "-----BEGIN") return Promise.resolve(value);
        return getKey(value);
    }

    /* The recipients field: the tokenizer's escape()d, comma-separated entries. */
    function recipientEntries(value) {
        return String(value || "").split(",").filter(Boolean).map(function(item) {
            return item.slice(0, 11) == "-----BEGIN%" ? unescape(item) : item;
        });
    }

    function isRsa(key) {
        var algo = key.getAlgorithmInfo().algorithm;
        return algo === "rsaEncryptSign" || algo === "rsaSign" || algo === "rsaEncrypt";
    }

    /*
     * The device, connected, with this engine's hooks for YOUR key and its
     * challenge code shown in the page's status line while it waits.
     */
    function device(myKey, which) {
        activeApi = _api;
        return okLib.okcrypto().then(function(ok) {
            var offset = isRsa(myKey) ? 0 : ECC_OFFSET;
            classic.registerClassicHooks(openpgp, ok,
                which === "sign" ? { signSlot: SIGN_SLOT + offset } : { decryptSlot: DECRYPT_SLOT + offset });
            if (!listening.has(ok)) {
                listening.add(ok);
                ok.on("challenge", function(e) {
                    if (e && e.digits && e.digits.length) {
                        if (activeApi) activeApi.emit("status", "Confirm on your OnlyKey - tap any button, or press " + e.digits.join("-") + " if it asks for a challenge code.");
                    }
                });
            }
            app.emit(which === "sign" ? "ok-signing" : "ok-decrypting");
            return openpgp.createHardwarePrivateKey(myKey);
        });
    }

    function signerLabel(key) {
        var email = (key.users[0] && key.users[0].userID && key.users[0].userID.email) || "";
        var fingerprint = key.getFingerprint().toUpperCase();
        return { userid: email.split("@")[0], keyid: fingerprint.slice(-16) };
    }

    function finish(statusText, result, callback) {
        _api.emit("status", statusText);
        _api.emit("done");
        callback(null, result);
        _$status("finished");
        app.emit("ok-connected");
        return result;
    }

    function fail(err, callback) {
        _api.emit("error", errorText(err));
        app.emit("ok-error");
        if (callback) callback(err);
    }

    /* ---------------------------------------------------------- encrypt */

    async function startEncryption(to_pgpkeys, from_signer, message, file, callback) {
        _api.emit("working");
        var signs = _$mode_is("Encrypt and Sign") || _$mode_is("Sign Only");
        var encrypts = !_$mode_is("Sign Only");
        try {
            var recipients = [];
            if (encrypts) {
                _api.emit("status", "Checking recipient's public key...");
                var entries = recipientEntries(to_pgpkeys);
                for (var i = 0; i < entries.length; i++) {
                    var armored = await resolveKey(entries[i]);
                    if (!armored) { _api.emit("error", "I need recipient's public pgp key :("); return; }
                    recipients.push(await openpgp.readKey({ armoredKey: armored }));
                }
                if (!recipients.length) { _api.emit("error", "I need recipient's public pgp key to encrypt :("); return; }
            }
            var signingKey = null;
            if (signs) {
                _api.emit("status", "Checking sender's public key...");
                var mine = await resolveKey(from_signer);
                if (!mine) { _api.emit("error", "I need sender's public pgp key :("); return; }
                var myKey = await openpgp.readKey({ armoredKey: mine });
                signingKey = await device(myKey, "sign");
            }

            if (message == null) return encryptFile(recipients, signingKey, file, callback);

            _api.emit("status", signs && encrypts ? "Encrypting and signing message ..."
                : encrypts ? "Encrypting message ..." : "Signing message ...");
            var msg = await openpgp.createMessage({ text: message });
            var out = encrypts
                ? await openpgp.encrypt({ message: msg, encryptionKeys: recipients, signingKeys: signingKey || undefined })
                : await openpgp.sign({ message: msg, signingKeys: signingKey });
            return finish(_$mode_is("Sign Only")
                ? "Done :)  Click here to copy message, then paste signed message into an email, IM, whatever."
                : "Done :)  Click here to copy message, then paste encrypted message into an email, IM, whatever.",
            out, callback);
        } catch (err) {
            fail(err, callback);
        }
    }

    /* The selected files, zipped (DEFLATE level 1, as before), sealed, downloaded as <name>.zip.gpg. */
    async function encryptFile(recipients, signingKey, f, callback) {
        if (!f || !f.files || !f.files.length) { _api.emit("error", "No files selected :("); return; }
        var zip = new JSZip();
        var txt = "";
        for (var i = 0; i < f.files.length; i++) {
            var one = f.files[i];
            if (!one.size) { _api.emit("error", "No files selected :("); return; }
            txt += "file name: " + one.name + " file size: " + one.size + " file type: " + one.type;
            zip.file(one.name, one);
        }
        var named = document.getElementById("filename");
        var filename = named && named.value ? named.value : f.files[0].name;
        _api.emit("status", f.files.length > 1 ? "Processing files" : "Processing " + filename);
        var details = document.getElementById("filedetails");
        if (details) details.innerHTML = txt;
        var zipped = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 1 } });
        var msg = await openpgp.createMessage({ binary: zipped });
        var out = recipients.length
            ? await openpgp.encrypt({ message: msg, encryptionKeys: recipients, signingKeys: signingKey || undefined, format: "binary" })
            : await openpgp.sign({ message: msg, signingKeys: signingKey, format: "binary" });
        saveAs(new Blob([out], { type: "text/plain;charset=utf-8" }), filename + ".zip.gpg");
        return finish((recipients.length ? "Done :)  downloading encrypted file " : "Done :)  downloading signed file ")
            + filename + ".zip.gpg", null, callback);
    }

    /* ---------------------------------------------------------- decrypt */

    async function startDecryption(signer, my_public, message, file, callback) {
        _api.emit("working");
        var verify = _$mode_is("Decrypt and Verify");
        try {
            var senderKey = null;
            if (verify) {
                if (signer == "") { _api.emit("error", "I need senders's public pgp key to verify :("); return; }
                var sender = await resolveKey(signer);
                if (sender) senderKey = await openpgp.readKey({ armoredKey: sender });
            }
            if (my_public == "") { _api.emit("error", "I need your's public pgp key to proceed :("); return; }
            var mine = await resolveKey(my_public);
            if (!mine) { _api.emit("error", "Your PublicKey is Invalid"); return; }
            var myKey = await openpgp.readKey({ armoredKey: mine });

            var encrypted = message != null
                ? await openpgp.readMessage({ armoredMessage: message })
                : await readFileMessage(file);
            if (!encrypted) return;

            /* Is this message for YOUR key at all? Said before the device is asked. */
            var mineIds = myKey.getKeyIDs().map(function(id) { return id.toHex(); });
            var forIds = encrypted.getEncryptionKeyIDs().map(function(id) { return id.toHex(); });
            if (!forIds.some(function(id) { return mineIds.indexOf(id) !== -1; })) {
                _api.emit("error", "Your PublicKey is Not found in message");
                return;
            }

            _api.emit("status", verify ? (message != null ? "Decrypting and verifying message ..." : "Decrypting and verifying...")
                : (message != null ? "Decrypting message ..." : "Decrypting..."));
            var decryptionKey = await device(myKey, "decrypt");
            var result = await openpgp.decrypt({
                message: encrypted,
                decryptionKeys: decryptionKey,
                verificationKeys: senderKey || undefined,
                format: message != null ? "utf8" : "binary",
            });

            var signedBy = null;
            if (verify && result.signatures.length) {
                await result.signatures[0].verified; // throws on a bad signature
                signedBy = signerLabel(senderKey);
            }
            if (message != null) {
                return finish(!verify ? "Done :) Click here to copy message"
                    : signedBy ? "Done :) Signed by " + signedBy.userid + " (Key ID: " + signedBy.keyid + "), Click here to copy message"
                    : "Done :) Message has no signature, Click here to copy message",
                result.data, callback);
            }
            var filename = file.files[0].name.slice(0, -4);
            saveAs(new Blob([result.data], { type: "text/plain;charset=utf-8" }), filename);
            return finish(!verify ? "Done :)  downloading decrypted file " + filename
                : signedBy ? "Done :) Signed by " + signedBy.userid + " (Key ID: " + signedBy.keyid + "), downloading decrypted file " + filename
                : "Done :) file has no signature, downloading decrypted file " + filename,
            null, callback);
        } catch (err) {
            fail(err, callback);
        }
    }

    function readFileMessage(f) {
        if (!f || !f.files || !f.files.length) { _api.emit("error", "No files selected :("); return Promise.resolve(null); }
        return f.files[0].arrayBuffer().then(function(buf) {
            return openpgp.readMessage({ binaryMessage: new Uint8Array(buf) });
        });
    }

    _api.startEncryption = startEncryption;
    _api.startDecryption = startDecryption;
    _api._$status = _$status;
    _api._$reset = _$reset;
    _api._$status_is = _$status_is;
    _api._$mode = _$mode;
    _api._$mode_is = _$mode_is;
    return _api;
};
