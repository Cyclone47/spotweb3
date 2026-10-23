'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NntpClientPool, WebSocketNntpConnection } = require('../../js/browser-download/nntp-client');

test('next batch downloads while the preceding batch is being written', async () => {
    const pool = new NntpClientPool({ maxConnections: 1, batchSize: 1, shareConnections: false });
    const requested = [];
    pool.fetchBatchWithRetry = async (_, ids) => {
        requested.push(...ids);
        return ids.map(messageId => ({ messageId, status: 222, body: new Uint8Array(1) }));
    };
    const processed = [];
    await pool.downloadSegments(['a', 'b', 'c'].map(messageId => ({ messageId })), async task => {
        processed.push(task.messageId);
        if (task.messageId === 'a') assert.deepEqual(requested, ['a', 'b']);
    });
    assert.deepEqual(processed, ['a', 'b', 'c']);
    pool.close();
});

test('prefetch failure is propagated, and each successful segment is processed once', async () => {
    const pool = new NntpClientPool({ maxConnections: 1, batchSize: 1, shareConnections: false });
    pool.fetchBatchWithRetry = async (_, ids) => {
        if (ids[0] === 'b') throw new Error('provider failure');
        return [{ messageId: ids[0], status: 222 }];
    };
    const processed = [];
    await assert.rejects(pool.downloadSegments(['a', 'b'].map(messageId => ({ messageId })), async task => {
        await new Promise(resolve => setTimeout(resolve, 10));
        processed.push(task.messageId);
    }), /provider failure/);
    assert.deepEqual(processed, ['a']);
    pool.close();
});

test('article failure after a successful WebSocket handshake never downgrades to HTTP', async () => {
    const pool = new NntpClientPool({ mode: 'ws', wsUrl: 'ws://example.test', maxRetries: 0, shareConnections: false });
    pool._getWsConnection = () => ({
        ensureConnected: async () => {},
        fetchBatch: async () => { throw Object.assign(new Error('article timeout'), { retryable: true }); }
    });
    let httpCalls = 0;
    pool._fetchHttpBatch = async () => { httpCalls++; return []; };
    await assert.rejects(pool.fetchBatchWithRetry(0, ['a']), /article timeout/);
    assert.equal(httpCalls, 0);
    assert.equal(pool.mode, 'ws');
    pool.close();
});

test('WebSocket error without close rejects instead of hanging forever', async () => {
    class FailedSocket {
        constructor() { setTimeout(() => this.onerror(), 0); }
        close() {}
    }
    const conn = new WebSocketNntpConnection('ws://example.test', '', { WebSocketImpl: FailedSocket });
    await assert.rejects(conn.ensureConnected(), { code: 'WS_CONNECT_ERROR' });
});
