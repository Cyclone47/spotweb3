"""Verify setup queues and starts retrieval without a Refresh click or real provider."""
import http.cookiejar
import json
import re
import sys
import time
import urllib.parse
import urllib.request

base = sys.argv[1].rstrip('/')
browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
html = browser.open(base + '/?page=setup', timeout=10).read().decode()
token = re.search(r'name="setupform\[xsrfid\]"[^>]*value="([^"]+)"', html).group(1)
fields = {
    'xsrfid': token, 'submitfinish': '1', 'theme': 'auto', 'firstname': 'CI',
    'lastname': 'Setup', 'username': 'sync-smoke-user', 'mail': 'sync-smoke@example.test',
    'newpassword1': 'ci-password', 'newpassword2': 'ci-password', 'download_method': 'nzb',
    # Refuses connections immediately: no third-party Usenet account or traffic.
    'nntp_host': '127.0.0.1', 'nntp_port': '1', 'nntp_enc': 'none',
    'nntp_user': '', 'nntp_pass': '', 'anonymous': '1',
}
body = urllib.parse.urlencode({'setupform[' + key + ']': value for key, value in fields.items()}).encode()
started = time.time()
result = browser.open(base + '/?page=setup', data=body, timeout=10).read().decode()
assert 'id="wiz"' not in result, 'Setup did not finish successfully'
assert time.time() - started < 10, 'Setup waited for NNTP retrieval instead of returning'
while time.time() - started < 30:
    status = json.load(browser.open(base + '/?page=syncstatus', timeout=10))
    assert status['initialSyncIncomplete'], 'Incomplete initial sync was not exposed to the overview'
    if status['schedule'].get('attempted', 0) >= int(started):
        print('PASS setup completed, queued retrieval in manual-only mode and started it without a Refresh click')
        break
    assert status['schedule']['queued'], 'Setup did not queue the initial retrieval request'
    time.sleep(1)
else:
    raise AssertionError('Background scheduler did not start the initial request')
