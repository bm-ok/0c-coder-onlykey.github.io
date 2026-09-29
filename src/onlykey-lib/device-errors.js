/*
 * Device error strings that need more than the device can say in 64 bytes.
 *
 * Each explanation opens by restating the firmware's message in plain words,
 * so a user quoting the page can still be matched to the firmware source.
 */
'use strict';

var EXPLAIN = {
  // ok_extension.cpp: a stored-slot OKSIGN/OKDECRYPT (PGP, and the PGP-PQC
  // composite slots) at webcrypt level 1. ALLOWED while field 31 is unset (the
  // v3.0.4 default, unless legacy field 21 bit 1 is set - okcore.cpp
  // okcore_webcrypt_policy, release 3.1.0); a written field 31 without bit 0
  // (OKWC_ALLOW_STORED_KEY) turns it off. Firmware before libraries 6ddc82b
  // dropped this message, so the page just stopped.
  'Error stored key use over FIDO2 not enabled':
    'Stored-key (PGP) use by the web app is not enabled on this OnlyKey. ' +
    'To allow it, put the key in config mode and turn on "Allow Webcrypt to use ' +
    'my stored keys (PGP)" in the OnlyKey app\'s Preferences, or run ' +
    '"onlykey-cli webcryptpolicy 1". Derived keys work without it.',
};

/**
 * Return a user-facing message for a device error string. The sentence may
 * arrive inside a longer message - node-onlykey-lib wraps what the device said
 * with what it was asked - so it is found, not just compared.
 */
function explainDeviceError(text) {
  var t = String(text || '').replace(/\0+$/, '').trim();
  for (var said in EXPLAIN) {
    if (t.indexOf(said) !== -1) return EXPLAIN[said];
  }
  return t;
}

module.exports = { explainDeviceError: explainDeviceError, EXPLAIN: EXPLAIN };
