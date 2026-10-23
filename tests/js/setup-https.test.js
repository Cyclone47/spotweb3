'use strict';
const assert = require('node:assert/strict');
const { httpsUrl } = require('../../js/setup-https.js');
const fs = require('node:fs');
const vm = require('node:vm');
assert.equal(httpsUrl('http://192.0.2.10:8080/?page=setup&unused=value#downloads', 443), 'https://192.0.2.10/?page=setup');
assert.equal(httpsUrl('http://spotweb.lan/subdir/?page=setup', 8443), 'https://spotweb.lan:8443/subdir/?page=setup');
assert.equal(httpsUrl('http://[fd00::1]:8080/', 443), 'https://[fd00::1]/?page=setup');
assert.equal(httpsUrl('http://user:password@spotweb.lan/', 443), 'https://spotweb.lan/?page=setup');

function wizard(protocol, secure, supported) {
    const elements = {};
    for (const id of ['https-setup', 'https-status', 'https-enable', 'https-later', 'https-instructions', 'https-continue']) {
        elements[id] = { hidden: id === 'https-instructions', events: {},
            getAttribute: () => '8443', addEventListener(event, callback) { this.events[event] = callback; } };
    }
    const context = { URL, window: { isSecureContext: secure,
        location: { protocol, href: protocol + '//192.0.2.10:8080/?page=setup' },
        spotwebBrowserDownloadManager: { checkBrowserSupport: () => ({ supported }) } },
    document: { getElementById: id => elements[id], addEventListener: (event, callback) => callback() } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../../js/setup-https.js'), 'utf8'), context);
    return elements;
}
const http = wizard('http:', false, false);
assert.equal(http['https-setup'].hidden, false);
assert.equal(http['https-continue'].href, 'https://192.0.2.10:8443/?page=setup');
http['https-enable'].events.click();
assert.equal(http['https-instructions'].hidden, false);
http['https-later'].events.click();
assert.equal(http['https-setup'].hidden, true);
const blocked = wizard('https:', false, false);
assert.equal(blocked['https-enable'].hidden, true);
assert.match(blocked['https-status'].textContent, /Trust the local certificate/);
const unsupported = wizard('https:', true, false);
assert.match(unsupported['https-status'].textContent, /Try desktop Chrome or Edge/);
const ready = wizard('https:', true, true);
assert.match(ready['https-status'].textContent, /features are available/);
assert.equal(wizard('http:', true, true)['https-setup'].hidden, true);
console.log('HTTPS onboarding URL and interaction tests passed.');
