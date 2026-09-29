/*
 * App utilities the classic PGP pages use that are not OnlyKey protocol -
 * moved here unchanged from the in-repo library (getKey from
 * src/onlykey-fido2/plugin.js, getAllUrlParams from onlykey.extra.js) so they
 * survive when that library is deleted.
 *
 * getKey(url, force?): a public key - pasted armored text as is, an https://
 * URL fetched, anything with '@' through the protonmail lookup, anything else
 * from keybase. Resolves false on any failure.
 */
module.exports = function(window) {
    const request = require('superagent');
        var getKey = function getKey(url, statusFn_force) {
            var statusFn, force;
            if (typeof statusFn_force == "string")
                force = statusFn_force;

            if (!url) return new Promise(resolve => { resolve(false) });

            //pgp key 
            if (url.slice(0, 10) == '-----BEGIN')
                return new Promise(resolve => {
                    if (statusFn) statusFn('Loaded public key (input) ...');
                    resolve(url);
                });

            if (force) {
                switch (force) {
                    case 'protonmail':
                        return protonmail();
                    case 'keybase':
                        return protonmail();
                    case 'secure':
                        return secure();
                    default:
                        break;
                }
            }


            if (url.slice(0, 8) == 'https://') return secure();
            if (!(url.indexOf("@") == -1)) return protonmail();
            return keybase();

            //direct url
            function secure() {
                return new Promise(resolve => {
                    if (statusFn) statusFn('Downloading public key (https-url) ...');
                    request
                        .get(url)
                        .end((err, key) => {
                            if (err) {
                                resolve(false);
                                //err.message += ' Try to directly paste the public PGP key in.';
                                //this.showError(err);
                                return;
                            }
                            resolve(key.text);
                            return key.text;
                        });
                });
            }
            //protonmail 
            function protonmail() {
                return new Promise(resolve => {
                    if (statusFn) statusFn('Downloading public key (protonmail) ...');
                    url = 'https://onlykey.herokuapp.com/protonmail/get/' + url;
                    request
                        .get(url)
                        .set("Content-Type", "text/plain")
                        .end((err, key) => {
                            if (err) {
                                resolve(false);
                                //err.message += ' Try to directly paste the public PGP key in.';
                                //this.showError(err);
                                return;
                            }
                            resolve(key.text);
                            return key.text;
                        });
                });
            }
            //keybase  or url
            function keybase() {
                return new Promise(resolve => {
                    //button.textContent = 'Downloading public key ...';
                    if (statusFn) statusFn('Downloading public key (keybase) ...');
                    url = 'https://keybase.io/'.concat(url, '/pgp_keys.asc');
                    request
                        .get(url)
                        .end((err, key) => {
                            if (err) {
                                resolve(false);
                                //err.message += ' Try to directly paste the public PGP key in.';
                                //this.showError(err);
                                return;
                            }
                            resolve(key.text);
                            return key.text;
                        });
                });
            }
        };

    function getAllUrlParams(url) {
      // get query string from url (optional) or window
      var queryString = url ? url.split('?')[1] : window.location.search.slice(1);
      // we'll store the parameters here
      var obj = {
        "#": window.location.hash.split('#')[1] // add the hash
      };
      // if query string exists
      if (queryString) {
        // stuff after # is not part of query string, so get rid of it
        queryString = queryString.split('#')[0];
        // split our query string into its component parts
        var arr = queryString.split('&');
        for (var i = 0; i < arr.length; i++) {
          // separate the keys and the values
          var a = arr[i].split('=');
          // set parameter name and value (use 'true' if empty)
          var paramName = a[0];
          var paramValue = typeof(a[1]) === 'undefined' ? true : a[1];
  
          // (optional) keep case consistent
          //paramName = paramName.toLowerCase();
          //if (typeof paramValue === 'string') paramValue = paramValue.toLowerCase();
  
          // if the paramName ends with square brackets, e.g. colors[] or colors[2]
          if (paramName.match(/\[(\d+)?\]$/)) {
            // create key if it doesn't exist
            var key = paramName.replace(/\[(\d+)?\]/, '');
            if (!obj[key]) obj[key] = [];
            // if it's an indexed array e.g. colors[2]
            if (paramName.match(/\[\d+\]$/)) {
              // get the index value and add the entry at the appropriate position
              var index = /\[(\d+)\]/.exec(paramName)[1];
              obj[key][index] = paramValue;
            }
            else {
              // otherwise add the value to the end of the array
              obj[key].push(paramValue);
            }
          }
          else {
            // we're dealing with a string
            if (!obj[paramName]) {
              // if it doesn't exist, create property
              obj[paramName] = paramValue;
            }
            else if (obj[paramName] && typeof obj[paramName] === 'string') {
              // if property does exist and it's a string, convert it to an array
              obj[paramName] = [obj[paramName]];
              obj[paramName].push(paramValue);
            }
            else {
              // otherwise add the property
              obj[paramName].push(paramValue);
            }
          }
        }
      }
      return obj;
    }

    return { getKey: getKey, getAllUrlParams: getAllUrlParams };
};
