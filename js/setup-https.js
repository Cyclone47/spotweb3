/* HTTPS is provisioned by the root installer. The wizard only changes URLs. */
(function () {
    'use strict';
    function httpsUrl(currentUrl, port) {
        var url = new URL(currentUrl);
        url.protocol = 'https:';
        url.port = String(port);
        url.search = '?page=setup';
        url.hash = '';
        url.username = '';
        url.password = '';
        return url.href;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { httpsUrl: httpsUrl };
    }
    if (typeof document === 'undefined') return;
    document.addEventListener('DOMContentLoaded', function () {
        var panel = document.getElementById('https-setup');
        if (!panel) return;
        var manager = window.spotwebBrowserDownloadManager;
        var supported = manager && manager.checkBrowserSupport().supported;
        panel.hidden = window.location.protocol !== 'https:' && window.isSecureContext && supported;
        if (panel.hidden) return;
        var enable = document.getElementById('https-enable');
        var instructions = document.getElementById('https-instructions');
        var later = document.getElementById('https-later');
        if (later) later.addEventListener('click', function () { panel.hidden = true; });
        if (window.location.protocol === 'https:') {
            if (enable) enable.hidden = true;
            if (later) later.hidden = true;
            document.getElementById('https-status').textContent = window.isSecureContext
                ? (supported ? 'HTTPS is active and the required browser features are available. Choose your download folder in the Downloads step.'
                    : 'HTTPS is active, but this browser does not provide all required download features. Try desktop Chrome or Edge.')
                : 'HTTPS is active, but the browser still blocks the required features. Trust the local certificate using the instructions below, then reopen this page.';
        } else if (enable) {
            // Port comes from installer-generated Apache configuration, never a form.
            var port = enable.getAttribute('data-port');
            document.getElementById('https-continue').href = httpsUrl(window.location.href, port);
            enable.addEventListener('click', function () {
                instructions.hidden = false;
                enable.hidden = true;
            });
        }
    });
}());
