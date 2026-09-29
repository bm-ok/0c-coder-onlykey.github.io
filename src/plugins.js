console.log("OnlyKey App Mode", process.env.NODE_ENV);

/*
This is the plugins.js file. We loads all the app plugins

some plugins can be used just for development or production
*/
module.exports = [
  
  /* the gun plugin contains helpers for gun  */
  require("./lib/gun.js"),
  
  /* node-onlykey-lib, the shared library pages are moving onto (service okLib) */
  require("./onlykey-lib/plugin.js"),
  
  /* pages plugin is the heart of the app state */
  require("./plugins/pages/pages.js"),
  
  
  require("./plugins/past_releases/past_releases.js")

];

module.exports.push(require("./plugins/bs_modal_dialog/bs_modal_dialog.js"));

module.exports.push(require("./plugins/fancy-icons/fi.js"));

module.exports.push(require("./plugins/index/index.js"));

module.exports.push(require("./plugins/xterm_console/index.js"));

module.exports.push(require("./plugins/encrypt/encrypt.js"));

module.exports.push(require("./plugins/decrypt/decrypt.js"));

module.exports.push(require("./plugins/search/search.js"));

module.exports.push(require("./plugins/ok-status-icon/ok-status-icon.js"));

// The PQC pages ship. They were in plugins-devel.js, which is development-only
// and throws if it ever reaches a production bundle - so `BUILD.sh 1` produced
// a site with no /app/age-derive.html and no /app/pgp-pqc.html at all, while
// the deployed site (a dev build) had them. That split meant the thing being
// released was never the thing being built for release.
module.exports.push(require("./plugins/age-derive/age-derive.js"));

module.exports.push(require("./plugins/pgp-pqc/pgp-pqc.js"));

if (!!(process.env.NODE_ENV === "production")) {//is production
  
  //production only plugins (we should have sister plugins enabled in plugins-devel.js)
  
  // ------------------------------------------------------------------------
  // The "console" service. Both plugins PROVIDE it and other plugins consume
  // it - console.js registers no-op methods (output suppressed),
  // console_debug.js registers the real console. Removing the line entirely
  // breaks the app with "Could not resolve dependencies / Missing services:
  // console", so it is always exactly one of the two.
  //
  // Production (apps.onlykey.io, and the app apps.crp.to routes new firmware
  // to) gets console.js. Staging (onlyagent.app) is built with
  // OK_WEB_DEBUG_CONSOLE=1 and keeps the real console: with output suppressed
  // the app reported nothing at all when the FIDO2 derived-key path hung on
  // 2026-09-15, leaving only the device's (lossy) serial log to diagnose from.
  //
  // onlyagent.app is deliberately not in the firmware's origin table
  // (webcryptcheck(), device.cpp) - only apps.crp.to and apps.onlykey.io are.
  // Staging runs against DEBUG firmware, which trusts every origin.
  // OK_WEB_DEBUG_CONSOLE is substituted at build time by webpack.config.js.
  if (process.env.OK_WEB_DEBUG_CONSOLE === "1") {
    module.exports.push(require("./plugins/console/console_debug.js"));
  } else {
    module.exports.push(require("./plugins/console/console.js"));
  }
  // ------------------------------------------------------------------------
  
}else{//is development
  //instead of including DEV plugins in production builds, 
  //put your DEV plugins in `plugins-devel.js` so webpack wont include it in production
}
