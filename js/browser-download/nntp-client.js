/**
 * Spotweb Browser Download Engine - NNTP Client & Bounded Connection Pool
 *
 * Supports two transport modes so Spotweb works both on stock PHP-only servers
 * and on high-throughput WebSocket relay setups without requiring the user to
 * install anything:
 *
 * 1. WebSocket Relay Mode ('ws' / 'wss'):
 *    Connects to Spotweb's authenticated NNTP WebSocket relay (`bin/nntp-relay.php`).
 *    Supports pipelined `BODY <message-id>` requests with binary frame delivery
 *    or RFC 3977 multiline response framing (`222 ... \r\n.\r\n` / `430 ...`).
 *
 * 2. Bounded-Batch HTTP Streaming Relay Mode ('http'):
 *    Connects to `?page=nntprelay&action=batch` over standard HTTPS/HTTP.
 *    Requests batches of segments per call and parses binary-framed responses:
 *    [status: u16 BE][idLen: u16 BE][bodyLen: u32 BE][idBytes][bodyBytes]
 *
 * Features:
 * - Bounded connection pool (configurable 1 to 100 concurrent connections/streams)
 * - Pipelining / batching for high throughput over high-RTT links
 * - Per-segment timeouts, automatic retries with exponential backoff + jitter
 * - Instant cancellation via AbortSignal
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SpotwebNntpClient = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    class NntpError extends Error {
        constructor(code, message, retryable) {
            super(message);
            this.name = 'NntpError';
            this.code = code;
            this.retryable = Boolean(retryable);
        }
    }

    /**
     * Parses a binary batch buffer returned by either HTTP batch relay or WS binary frame.
     * Frame format (repeating):
     *   0..1: u16 BE status code (e.g. 222 = body follows, 430 = no such article, 502 = upstream error)
     *   2..3: u16 BE messageId UTF-8 byte length
     *   4..7: u32 BE body byte length
     *   8..(8+idLen): messageId UTF-8 bytes
     *   (8+idLen)..(8+idLen+bodyLen): raw article body bytes (dot-unstuffed by relay or raw)
     *
     * @param {Uint8Array} buffer
     * @returns {Array<{ status: number, messageId: string, body: Uint8Array }>}
     */
    function parseBinaryBatchFrames(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const textDecoder = new TextDecoder('utf-8');
        const results = [];
        let offset = 0;

        while (offset + 8 <= bytes.length) {
            const status = view.getUint16(offset, false);
            const idLen = view.getUint16(offset + 2, false);
            const bodyLen = view.getUint32(offset + 4, false);
            offset += 8;

            if (offset + idLen + bodyLen > bytes.length) {
                throw new NntpError('FRAME_TRUNCATED', 'Truncated binary NNTP batch frame', true);
            }

            const messageId = textDecoder.decode(bytes.subarray(offset, offset + idLen));
            offset += idLen;

            const body = bytes.subarray(offset, offset + bodyLen);
            offset += bodyLen;

            results.push({ status, messageId, body });
        }

        return results;
    }

    /**
     * Encodes binary batch frames (used by relay & test servers).
     *
     * @param {Array<{ status: number, messageId: string, body?: Uint8Array }>} items
     * @returns {Uint8Array}
     */
    function encodeBinaryBatchFrames(items) {
        const textEncoder = new TextEncoder();
        const encodedIds = [];
        let totalSize = 0;

        for (let i = 0; i < items.length; i++) {
            const idBytes = textEncoder.encode(items[i].messageId || '');
            encodedIds.push(idBytes);
            const bodyLen = items[i].body ? items[i].body.byteLength : 0;
            totalSize += 8 + idBytes.byteLength + bodyLen;
        }

        const out = new Uint8Array(totalSize);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        let offset = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const idBytes = encodedIds[i];
            const body = item.body || new Uint8Array(0);

            view.setUint16(offset, item.status || 222, false);
            view.setUint16(offset + 2, idBytes.byteLength, false);
            view.setUint32(offset + 4, body.byteLength, false);
            offset += 8;

            out.set(idBytes, offset);
            offset += idBytes.byteLength;

            if (body.byteLength > 0) {
                out.set(body, offset);
                offset += body.byteLength;
            }
        }

        return out;
    }

    /**
     * WebSocket connection worker within the pool.
     * Supports binary-framed responses (`parseBinaryBatchFrames`) as well as raw RFC 3977
     * multiline responses (`222 0 <id>\r\n...\r\n.\r\n` or `430 No such article\r\n`).
     */
    class WebSocketNntpConnection {
        constructor(wsUrl, token, options = {}) {
            this.wsUrl = wsUrl;
            this.token = token;
            this.timeoutMs = options.timeoutMs || 30000;
            this.WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
            this.ws = null;
            this.connected = false;
            this.connectingPromise = null;
            this.pendingMap = new Map(); // messageId -> { resolve, reject, timer }
            this.pendingFIFO = [];       // queue for unnamed RFC 3977 responses
            this.rxChunks = [];
            this.rxLength = 0;
        }

        async ensureConnected() {
            if (this.connected && this.ws && this.ws.readyState === 1) {
                return;
            }
            if (this.connectingPromise) {
                return this.connectingPromise;
            }
            if (!this.WebSocketImpl) {
                throw new NntpError('NO_WEBSOCKET', 'WebSocket is not available in this environment', false);
            }

            this.connectingPromise = new Promise((resolve, reject) => {
                const urlObj = new URL(this.wsUrl, typeof location !== 'undefined' ? location.href : 'http://localhost');
                if (urlObj.protocol === 'http:') {
                    urlObj.protocol = 'ws:';
                } else if (urlObj.protocol === 'https:') {
                    urlObj.protocol = 'wss:';
                }
                if (this.token) {
                    urlObj.searchParams.set('token', this.token);
                }
                const ws = new this.WebSocketImpl(urlObj.toString());
                ws.binaryType = 'arraybuffer';

                const connectTimer = setTimeout(() => {
                    this.connectingPromise = null;
                    try { ws.close(); } catch (_) {}
                    reject(new NntpError('WS_CONNECT_TIMEOUT', 'WebSocket NNTP relay connection timed out', true));
                }, this.timeoutMs);

                ws.onopen = () => {
                    clearTimeout(connectTimer);
                    this.ws = ws;
                    this.connected = true;
                    this.connectingPromise = null;
                    resolve();
                };

                ws.onmessage = (event) => {
                    this._onMessage(event.data);
                };

                ws.onerror = () => {
                    clearTimeout(connectTimer);
                    this.connectingPromise = null;
                    reject(new NntpError('WS_CONNECT_ERROR', 'WebSocket relay connection failed', true));
                };

                ws.onclose = (ev) => {
                    clearTimeout(connectTimer);
                    this.connected = false;
                    this.ws = null;
                    this.connectingPromise = null;
                    const err = new NntpError(
                        'WS_CLOSED',
                        'WebSocket closed (' + (ev && ev.code ? ev.code : 'unknown') + ')',
                        true
                    );
                    this._failAllPending(err);
                    reject(err);
                };
            });

            return this.connectingPromise;
        }

        _onMessage(data) {
            let bytes;
            if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else if (ArrayBuffer.isView(data)) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            } else if (typeof data === 'string') {
                bytes = new TextEncoder().encode(data);
            } else {
                return;
            }

            // Check if this is a binary batch frame from our relay:
            // Status codes in binary frames are 200..599, so byte 0 is 0x00 or 0x01 or 0x02 ('2' in ASCII is 0x32 = 50).
            // Because 200..599 in big-endian u16 has byte[0] <= 0x02, whereas ASCII text responses start with '2'/'4'/'5' (0x32..0x35),
            // binary frames and ASCII RFC 3977 responses are 100% unambiguous on the first byte!
            if (bytes.length >= 8 && bytes[0] <= 0x03 && this.rxLength === 0) {
                try {
                    const frames = parseBinaryBatchFrames(bytes);
                    for (let i = 0; i < frames.length; i++) {
                        this._resolvePending(frames[i].messageId, frames[i]);
                    }
                    return;
                } catch (err) {
                    // Fall through or fail if corrupted
                }
            }

            // Otherwise accumulate raw RFC 3977 stream bytes
            this.rxChunks.push(bytes);
            this.rxLength += bytes.length;
            this._drainRfc3977Stream();
        }

        _flattenRx() {
            if (this.rxChunks.length === 0) return new Uint8Array(0);
            if (this.rxChunks.length === 1) return this.rxChunks[0];
            const merged = new Uint8Array(this.rxLength);
            let offset = 0;
            for (let i = 0; i < this.rxChunks.length; i++) {
                merged.set(this.rxChunks[i], offset);
                offset += this.rxChunks[i].length;
            }
            this.rxChunks = [merged];
            return merged;
        }

        _consumeRx(count) {
            const buf = this._flattenRx();
            if (count >= buf.length) {
                this.rxChunks = [];
                this.rxLength = 0;
            } else {
                const rem = buf.subarray(count);
                this.rxChunks = [rem];
                this.rxLength = rem.length;
            }
        }

        _drainRfc3977Stream() {
            while (this.rxLength > 0) {
                const buf = this._flattenRx();
                // Find end of status line \r\n
                let eol = -1;
                const maxHeaderScan = Math.min(buf.length - 1, 512);
                for (let i = 0; i < maxHeaderScan; i++) {
                    if (buf[i] === 0x0D && buf[i + 1] === 0x0A) {
                        eol = i;
                        break;
                    }
                }
                if (eol === -1) return; // Need more bytes for status line

                const statusLine = new TextDecoder('ascii').decode(buf.subarray(0, eol));
                const statusCode = parseInt(statusLine.slice(0, 3), 10);

                // Extract <message-id> from status line if present
                let msgId = null;
                const lt = statusLine.indexOf('<');
                const gt = statusLine.indexOf('>', lt + 1);
                if (lt !== -1 && gt !== -1) {
                    msgId = statusLine.slice(lt + 1, gt);
                }

                // Greeting lines (200 / 201) when no request is pending
                if ((statusCode === 200 || statusCode === 201) && this.pendingFIFO.length === 0) {
                    this._consumeRx(eol + 2);
                    continue;
                }

                // Multiline response for 220, 221, 222
                if (statusCode === 220 || statusCode === 221 || statusCode === 222) {
                    // Look for terminator \r\n.\r\n starting from eol (in case body is empty: \r\n.\r\n)
                    let termPos = -1;
                    for (let i = eol; i + 4 < buf.length; i++) {
                        if (
                            buf[i] === 0x0D &&
                            buf[i + 1] === 0x0A &&
                            buf[i + 2] === 0x2E &&
                            buf[i + 3] === 0x0D &&
                            buf[i + 4] === 0x0A
                        ) {
                            termPos = i;
                            break;
                        }
                    }
                    if (termPos === -1) return; // Wait for rest of article body

                    const bodyStart = eol + 2;
                    // Copy out body slice before consuming rx buffer
                    const rawBody = buf.slice(bodyStart, termPos);
                    this._consumeRx(termPos + 5);

                    const targetId = msgId || this.pendingFIFO[0];
                    this._resolvePending(targetId, {
                        status: statusCode,
                        messageId: targetId || '',
                        body: rawBody
                    });
                } else {
                    // Single-line response (e.g., 430 No such article, 411, 502)
                    this._consumeRx(eol + 2);
                    const targetId = msgId || this.pendingFIFO[0];
                    this._resolvePending(targetId, {
                        status: statusCode,
                        messageId: targetId || '',
                        body: new Uint8Array(0)
                    });
                }
            }
        }

        _resolvePending(messageId, frame) {
            let entry = messageId ? this.pendingMap.get(messageId) : null;
            if (!entry && this.pendingFIFO.length > 0) {
                const fifoId = this.pendingFIFO[0];
                entry = this.pendingMap.get(fifoId);
                messageId = fifoId;
            }
            if (!entry) return;

            clearTimeout(entry.timer);
            this.pendingMap.delete(messageId);
            const idx = this.pendingFIFO.indexOf(messageId);
            if (idx !== -1) this.pendingFIFO.splice(idx, 1);

            entry.resolve(frame);
        }

        _failAllPending(err) {
            for (const [, entry] of this.pendingMap.entries()) {
                clearTimeout(entry.timer);
                entry.reject(err);
            }
            this.pendingMap.clear();
            this.pendingFIFO.length = 0;
            this.rxChunks = [];
            this.rxLength = 0;
        }

        /**
         * Requests a batch of message-IDs over the WebSocket connection (pipelined).
         * @param {string[]} messageIds
         * @param {AbortSignal} [signal]
         * @returns {Promise<Array<{ status: number, messageId: string, body: Uint8Array }>>}
         */
        async fetchBatch(messageIds, signal) {
            if (signal && signal.aborted) {
                throw new NntpError('ABORTED', 'Download aborted', false);
            }
            await this.ensureConnected();

            const promises = messageIds.map((id) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingMap.delete(id);
                    const idx = this.pendingFIFO.indexOf(id);
                    if (idx !== -1) this.pendingFIFO.splice(idx, 1);
                    reject(new NntpError('SEGMENT_TIMEOUT', `Timed out waiting for segment <${id}>`, true));
                }, this.timeoutMs);

                this.pendingMap.set(id, { resolve, reject, timer });
                this.pendingFIFO.push(id);
            }));

            // Send pipelined BODY commands or JSON batch command
            const cmdLines = messageIds.map((id) => `BODY <${id}>\r\n`).join('');
            this.ws.send(cmdLines);

            return Promise.all(promises);
        }

        close() {
            this._failAllPending(new NntpError('CLIENT_CLOSED', 'NNTP connection closed', false));
            if (this.ws) {
                try { this.ws.close(); } catch (_) {}
                this.ws = null;
            }
            this.connected = false;
        }
    }

    const sharedGovernors = new Map();

    class RelayConnectionGovernor {
        constructor(maxConnections) {
            this.maxConnections = Math.max(1, Math.min(100, Math.floor(Number(maxConnections) || 4)));
            this.busySlots = new Set();
            this.waitQueue = [];
        }

        setMaxConnections(maxConnections) {
            this.maxConnections = Math.max(1, Math.min(100, Math.floor(Number(maxConnections) || 4)));
            this._drain();
        }

        acquireSlot(preferredSlot, signal, isClosed) {
            if ((isClosed && isClosed()) || (signal && signal.aborted)) {
                return Promise.reject(new NntpError('ABORTED', 'Download aborted', false));
            }
            const freeSlot = this._takeFreeSlot(preferredSlot);
            if (freeSlot !== -1) {
                return Promise.resolve(freeSlot);
            }
            return new Promise((resolve, reject) => {
                const waiter = {
                    preferredSlot,
                    signal,
                    isClosed,
                    resolve: (slot) => {
                        if (signal && waiter.onAbort) {
                            signal.removeEventListener('abort', waiter.onAbort);
                        }
                        resolve(slot);
                    },
                    reject: (err) => {
                        if (signal && waiter.onAbort) {
                            signal.removeEventListener('abort', waiter.onAbort);
                        }
                        reject(err);
                    },
                    onAbort: null
                };
                if (signal) {
                    waiter.onAbort = () => {
                        const idx = this.waitQueue.indexOf(waiter);
                        if (idx !== -1) this.waitQueue.splice(idx, 1);
                        waiter.reject(new NntpError('ABORTED', 'Download aborted', false));
                    };
                    signal.addEventListener('abort', waiter.onAbort, { once: true });
                }
                this.waitQueue.push(waiter);
            });
        }

        _takeFreeSlot(preferredSlot) {
            if (this.busySlots.size >= this.maxConnections) {
                return -1;
            }
            if (
                Number.isInteger(preferredSlot) &&
                preferredSlot >= 0 &&
                preferredSlot < this.maxConnections &&
                !this.busySlots.has(preferredSlot)
            ) {
                this.busySlots.add(preferredSlot);
                return preferredSlot;
            }
            for (let i = 0; i < this.maxConnections; i++) {
                if (!this.busySlots.has(i)) {
                    this.busySlots.add(i);
                    return i;
                }
            }
            return -1;
        }

        releaseSlot(slot) {
            this.busySlots.delete(slot);
            this._drain();
        }

        cancelClosedWaiters() {
            for (let i = this.waitQueue.length - 1; i >= 0; i--) {
                const waiter = this.waitQueue[i];
                if ((waiter.isClosed && waiter.isClosed()) || (waiter.signal && waiter.signal.aborted)) {
                    this.waitQueue.splice(i, 1);
                    waiter.reject(new NntpError('ABORTED', 'Download aborted', false));
                }
            }
        }

        _drain() {
            this.cancelClosedWaiters();
            while (this.waitQueue.length > 0 && this.busySlots.size < this.maxConnections) {
                const waiter = this.waitQueue.shift();
                const slot = this._takeFreeSlot(waiter.preferredSlot);
                if (slot === -1) {
                    this.waitQueue.unshift(waiter);
                    break;
                }
                waiter.resolve(slot);
            }
        }
    }

    function getSharedGovernor(key, maxConnections) {
        let gov = sharedGovernors.get(key);
        if (!gov) {
            gov = new RelayConnectionGovernor(maxConnections);
            sharedGovernors.set(key, gov);
        } else {
            gov.setMaxConnections(maxConnections);
        }
        return gov;
    }

    /**
     * Bounded-Pool NNTP Client supporting both WebSocket pipelining and HTTP batch streaming.
     */
    class NntpClientPool {
        /**
         * @param {Object} config
         * @param {'ws'|'http'|'auto'} [config.mode='auto']
         * @param {string} [config.wsUrl] - WebSocket relay URL
         * @param {string} [config.httpBatchUrl] - HTTP batch endpoint URL (e.g. '?page=nntprelay&action=batch')
         * @param {string} [config.token] - Relay auth token
         * @param {number} [config.maxConnections=4] - Bounded concurrent connections (1..100)
         * @param {number} [config.batchSize=4] - Number of segments pipelined per batch request
         * @param {number} [config.maxRetries=3] - Max retries per transient failure
         * @param {number} [config.retryBaseDelayMs=300] - Base backoff delay in ms
         * @param {number} [config.timeoutMs=30000] - Per-batch timeout in ms
         * @param {boolean} [config.shareConnections=true] - Share connection limit across concurrent pools targeting the same relay
         * @param {Function} [config.fetchImpl] - Custom fetch implementation for tests
         * @param {Function} [config.WebSocketImpl] - Custom WebSocket class for tests
         */
        constructor(config = {}) {
            this.mode = config.mode || (config.wsUrl ? 'ws' : 'http');
            this.wsUrl = config.wsUrl || null;
            this.httpBatchUrl = config.httpBatchUrl || '?page=nntprelay&action=batch';
            this.token = config.token || '';
            this.maxConnections = Math.max(1, Math.min(100, Math.floor(Number(config.maxConnections) || 4)));
            this.batchSize = Math.max(1, Math.min(32, Number(config.batchSize) || 8));
            this.maxRetries = config.maxRetries !== undefined ? Number(config.maxRetries) : 3;
            this.retryBaseDelayMs = config.retryBaseDelayMs !== undefined ? Number(config.retryBaseDelayMs) : 300;
            this.timeoutMs = config.timeoutMs || 30000;
            this.fetchImpl = config.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
            this.WebSocketImpl = config.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);

            const govKey = `${this.wsUrl || ''}|${this.httpBatchUrl || ''}`;
            this.governor = config.shareConnections === false
                ? new RelayConnectionGovernor(this.maxConnections)
                : getSharedGovernor(govKey, this.maxConnections);

            this.wsConnections = [];
            this.wsEverConnected = false;
            this.fallbackReason = null;
            this.retryCount = 0;
            this.closed = false;
        }

        getDiagnostics() {
            return {
                transport: this.mode,
                activeConnections: this.wsConnections.filter(conn => conn && conn.connected).length,
                maxConnections: this.maxConnections,
                retries: this.retryCount,
                fallbackReason: this.fallbackReason
            };
        }

        _getWsConnection(slotIndex) {
            if (!this.wsConnections[slotIndex]) {
                this.wsConnections[slotIndex] = new WebSocketNntpConnection(this.wsUrl, this.token, {
                    timeoutMs: this.timeoutMs,
                    WebSocketImpl: this.WebSocketImpl
                });
            }
            return this.wsConnections[slotIndex];
        }

        /**
         * Fetches a batch of messageIds via HTTP POST (`?page=nntprelay&action=batch`).
         * @param {string[]} messageIds
         * @param {AbortSignal} [signal]
         */
        async _fetchHttpBatch(messageIds, signal) {
            if (!this.fetchImpl) {
                throw new NntpError('NO_FETCH', 'fetch API not available', false);
            }

            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = setTimeout(() => {
                if (controller) controller.abort();
            }, this.timeoutMs);

            const onAbort = () => {
                if (controller) controller.abort();
            };
            if (signal) {
                if (signal.aborted) {
                    clearTimeout(timer);
                    throw new NntpError('ABORTED', 'Download aborted', false);
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }

            try {
                const headers = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/octet-stream, application/json'
                };
                if (this.token) {
                    headers['X-Spotweb-Relay-Token'] = this.token;
                }

                const response = await this.fetchImpl(this.httpBatchUrl, {
                    method: 'POST',
                    headers,
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        token: this.token,
                        messageIds
                    }),
                    signal: controller ? controller.signal : undefined
                });

                if (!response.ok) {
                    let errMsg = `HTTP ${response.status}`;
                    try {
                        const errJson = await response.json();
                        if (errJson && errJson.error) errMsg = errJson.error;
                    } catch (_) {}
                    const retryable = response.status >= 500 || response.status === 429;
                    throw new NntpError('HTTP_' + response.status, errMsg, retryable);
                }

                const arrayBuf = await response.arrayBuffer();
                return parseBinaryBatchFrames(new Uint8Array(arrayBuf));
            } catch (err) {
                if (signal && signal.aborted) {
                    throw new NntpError('ABORTED', 'Download aborted', false);
                }
                if (err instanceof NntpError) throw err;
                throw new NntpError('NETWORK_ERROR', err.message || 'Network request failed', true);
            } finally {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
            }
        }

        /**
         * Fetches a batch of messageIds on a given connection slot with automatic retry & fallback.
         * @param {number} slotIndex
         * @param {string[]} messageIds
         * @param {AbortSignal} [signal]
         * @returns {Promise<Array<{ status: number, messageId: string, body: Uint8Array }>>}
         */
        async fetchBatchWithRetry(slotIndex, messageIds, signal) {
            let attempt = 0;
            while (true) {
                if (this.closed || (signal && signal.aborted)) {
                    throw new NntpError('ABORTED', 'Download aborted', false);
                }

                let acquiredSlot = -1;
                try {
                    acquiredSlot = await this.governor.acquireSlot(slotIndex, signal, () => this.closed);
                    if (this.mode === 'ws' && this.wsUrl) {
                        const conn = this._getWsConnection(acquiredSlot);
                        try {
                            await conn.ensureConnected();
                            // An article timeout is not evidence that the proxy blocks WebSockets.
                            this.wsEverConnected = true;
                            const frames = await conn.fetchBatch(messageIds, signal);
                            return frames;
                        } catch (wsErr) {
                            if (wsErr.code === 'ABORTED' || (signal && signal.aborted)) {
                                throw wsErr;
                            }
                            if (this.wsConnections[acquiredSlot]) {
                                this.wsConnections[acquiredSlot].close();
                                this.wsConnections[acquiredSlot] = null;
                            }
                            if (!this.wsEverConnected && this.httpBatchUrl && this.fetchImpl) {
                                this.mode = 'http';
                                this.fallbackReason = wsErr.code || 'WS_CONNECT_ERROR';
                                for (const socket of this.wsConnections) {
                                    if (socket) socket.close();
                                }
                                return await this._fetchHttpBatch(messageIds, signal);
                            }
                            throw wsErr;
                        }
                    }
                    return await this._fetchHttpBatch(messageIds, signal);
                } catch (err) {
                    if (err.code === 'ABORTED' || (signal && signal.aborted)) {
                        throw err;
                    }

                    attempt++;
                    this.retryCount++;
                    if (!err.retryable || attempt > this.maxRetries) {
                        throw err;
                    }
                } finally {
                    if (acquiredSlot !== -1) {
                        this.governor.releaseSlot(acquiredSlot);
                    }
                }

                const delay = this.retryBaseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 50);
                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, delay);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(t);
                            reject(new NntpError('ABORTED', 'Download aborted', false));
                        }, { once: true });
                    }
                });
            }
        }

        /**
         * Streams an ordered list of segment tasks across the bounded connection pool,
         * invoking `onSegment(task, frame)` as each segment arrives.
         *
         * @param {Array<{ messageId: string, [key: string]: any }>} segmentTasks
         * @param {function(Object, { status: number, messageId: string, body: Uint8Array }): Promise<void>} onSegment
         * @param {Object} [options]
         * @param {AbortSignal} [options.signal]
         * @param {function(): boolean} [options.isPaused]
         */
        async downloadSegments(segmentTasks, onSegment, options = {}) {
            const signal = options.signal;
            const isPaused = options.isPaused || (() => false);
            let nextIndex = 0;
            const total = segmentTasks.length;
            const workerCount = Math.min(this.maxConnections, Math.ceil(total / this.batchSize) || 1);

            const takeBatch = () => {
                const tasks = segmentTasks.slice(nextIndex, nextIndex + this.batchSize);
                nextIndex += tasks.length;
                return tasks;
            };
            // One batch of lookahead overlaps network transfer with decoding and disk writes.
            // Capture errors immediately so cancellation cannot leave an unhandled rejection.
            const fetchTasks = (slotIndex, tasks) => this.fetchBatchWithRetry(
                slotIndex, tasks.map(task => task.messageId), signal
            ).then(frames => ({ frames }), error => ({ error }));

            const runSlot = async (slotIndex) => {
                let batchTasks = [];
                let pending = null;
                while (pending || nextIndex < total) {
                    if (this.closed || (signal && signal.aborted)) {
                        throw new NntpError('ABORTED', 'Download aborted', false);
                    }
                    if (isPaused()) {
                        await new Promise((r) => setTimeout(r, 100));
                        continue;
                    }

                    if (!pending) {
                        batchTasks = takeBatch();
                        if (batchTasks.length === 0) break;
                        pending = fetchTasks(slotIndex, batchTasks);
                    }
                    const result = await pending;
                    if (result.error) throw result.error;
                    const frames = result.frames;
                    const nextTasks = !isPaused() ? takeBatch() : [];
                    pending = nextTasks.length ? fetchTasks(slotIndex, nextTasks) : null;

                    // Index frames by messageId for quick lookup
                    const frameMap = new Map();
                    for (let i = 0; i < frames.length; i++) {
                        frameMap.set(frames[i].messageId, frames[i]);
                    }

                    for (let i = 0; i < batchTasks.length; i++) {
                        const task = batchTasks[i];
                        const frame = frameMap.get(task.messageId) || frames[i] || {
                            status: 430,
                            messageId: task.messageId,
                            body: new Uint8Array(0)
                        };
                        await onSegment(task, frame);
                    }
                    batchTasks = nextTasks;
                }
            };

            const slots = [];
            for (let i = 0; i < workerCount; i++) {
                slots.push(runSlot(i));
            }

            await Promise.all(slots);
        }

        close() {
            this.closed = true;
            if (this.governor) {
                this.governor.cancelClosedWaiters();
            }
            for (let i = 0; i < this.wsConnections.length; i++) {
                if (this.wsConnections[i]) {
                    this.wsConnections[i].close();
                }
            }
            this.wsConnections = [];
        }
    }

    return {
        NntpError,
        parseBinaryBatchFrames,
        encodeBinaryBatchFrames,
        WebSocketNntpConnection,
        RelayConnectionGovernor,
        NntpClientPool
    };
}));
