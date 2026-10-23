# Download performance and spot retrieval

## Measured on 23 October 2026

Ten-second article-transfer samples using the same cached NZB, with browser
downloads paused for the direct tests:

| Path | Connections | Article throughput |
| --- | ---: | ---: |
| Direct provider connection inside Docker | 8 | 6.74 MB/s |
| Direct provider connection inside Docker | 40 | 11.36 MB/s |
| Direct provider connection from Windows | 8 | 6.94 MB/s |
| Direct provider connection from Windows | 40 | 8.06 MB/s |

The browser transfer used 40 WebSocket/provider connections. Container network
samples showed roughly 7–9 MB/s sent toward the browser, both before and after
the relay changes. These samples have different measurement boundaries from
the article-only benchmark. There is no demonstrated sustained throughput gain
from this change. The direct Windows test reproduces the slow range without
Docker or the browser relay, so neither alone explains the limit. Provider-side
limits and the network route remain to be investigated; a Wi-Fi speed test does
not establish throughput to this provider.

## Implemented changes

- TCP, TLS and STARTTLS authentication progress concurrently in the relay.
- Socket output uses bounded nonblocking writes and browser backpressure.
- Short TLS reads are drained instead of assuming the upstream buffer is empty.
- The browser prefetches one batch while decoding/writing the preceding batch.
- Article failures after a successful WebSocket connection do not cause an HTTP downgrade.
- Download status reports transport, WebSocket connection count, retries and a recent speed sample.

## Spot retrieval

Admin Center → Overview → Automatic spot retrieval offers manual-only,
5/15/30 minutes, hourly, 6/12 hours and daily. The existing 15-minute default
is preserved. `SPOTWEB_RETRIEVE_INTERVAL` supplies the default until a value is
saved in Admin Center. The entrypoint runs `bin/retrieve-scheduler.php` every
five seconds. Settings changes take effect on the next tick; manual-only still
allows Refresh. A lock prevents overlapping scheduler ticks, and the retriever's
existing command lock also prevents overlapping retrievals.

The top-right Refresh posts a permission-checked, CSRF-protected request to
`?page=syncstatus`. It no longer relies on a sidebar link or a page reload.
The scheduler records its heartbeat, last result and manual-request receipt in
the cache directory. Retrieval output is in `retriever-last.log` there.
Status polling updates the overview after retrieval while retaining the browser
download panel and worker. The status says “Last checked,” and shows retrieval
errors rather than treating an idle retriever as proof that the provider is current.

On installations without the Docker entrypoint, arrange to run
`php bin/retrieve-scheduler.php` at least every few seconds for these controls.
Existing direct `retrieve.php`/cron usage continues to work, but does not consume
the web interface's queued Refresh requests.

## Checks

```text
node tests/js/browser-download.test.js
node tests/js/browser-download-manager.test.js
node --test tests/js/nntp-throughput.test.js
php tests/integration/nntp-relay-io.php
php tests/integration/retrieval-schedule.php
```

The relay checks exercise concurrent plain/TLS/STARTTLS authentication, a slow
greeting, untrusted certificate rejection, slow-reader backpressure, partial
writes and fragmented article framing. Schedule checks cover interval validation,
changed intervals, manual-only requests, request deduplication and persisted state.
The running Admin Center was also used to save and restore the interval and
trigger retrieval from Refresh. New spots were subsequently imported.

For an opt-in provider benchmark, supply a JSON array of valid article IDs:

```text
php tests/integration/nntp-provider-benchmark.php /path/to/ids.json 8 10
```

Run this with browser downloads stopped so provider connection slots and bandwidth
are available. It downloads and discards article bodies without decoding or exporting them.
