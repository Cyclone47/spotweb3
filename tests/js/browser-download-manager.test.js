'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserDownloadManager } = require('../../js/browser-download/download-manager.js');

const originalDocument = global.document;
const originalFetch = global.fetch;
global.document = { baseURI: 'https://spotweb.test/app/', querySelectorAll: () => [] };
after(() => { global.document = originalDocument; global.fetch = originalFetch; });
const xml = '<nzb><file subject="&quot;test.bin&quot; yEnc"><groups><group>test</group></groups><segments><segment bytes="128" number="1">part@test</segment></segments></file></nzb>';

function manager() {
    const m = new BrowserDownloadManager();
    m.checkpointStore = { saveJob: async () => {}, listJobs: async () => [] };
    m._renderUI = () => {};
    m._setupUnloadWarning = () => {};
    m._ensureStylesAndDom = () => {};
    m.sent = [];
    m._ensureWorker = () => ({ postMessage: msg => m.sent.push(msg) });
    return m;
}
function descriptor() {
    return { ok: true, title: 'Test file', nzbXml: xml, relay: { mode: 'http', httpBatchUrl: '?page=nntprelay&action=batch' } };
}

test('selects a folder before initialization and does not fetch when the picker is cancelled', async () => {
    const m = manager();
    const order = [];
    m.init = async () => order.push('init');
    m.pickDestinationDirectory = async () => { order.push('picker'); throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); };
    global.fetch = async () => { throw new Error('Must not fetch after cancellation'); };
    assert.equal(await m.startSpotDownload('spot@test'), null);
    assert.deepEqual(order, ['picker']);
    assert.equal(m.jobs.size, 0);
});

test('single and bulk descriptor requests match the PHP contract and resolve worker URLs against the site', async () => {
    for (const ids of [['one@test'], ['one@test', 'two@test']]) {
        const m = manager();
        let requested;
        global.fetch = async url => { requested = new URL(url); return { ok: true, json: async () => descriptor() }; };
        await m.startSpotDownload(ids, { dirHandle: { name: 'Downloads' } });
        assert.equal(requested.searchParams.get('messageid[]'), null);
        if (ids.length === 1) assert.equal(requested.searchParams.get('messageid'), ids[0]);
        else assert.deepEqual(JSON.parse(requested.searchParams.get('messageids')), ids);
        assert.equal(m.sent[0].nzbXml, xml);
        assert.equal(m.sent[0].parsedNzb.files.length, 1);
        assert.equal(m.sent[0].relayConfig.httpBatchUrl, 'https://spotweb.test/app/?page=nntprelay&action=batch');
    }
});

test('rejects missing XML before creating a worker and retry retrieves the descriptor again', async () => {
    const m = manager();
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, nzbXml: {} }) });
    await assert.rejects(m.startSpotDownload('spot@test', { dirHandle: { name: 'Downloads' } }), /NZB content/);
    assert.equal(m.sent.length, 0);
    const job = [...m.jobs.values()][0];
    assert.equal(job.state, 'failed');
    global.fetch = async () => ({ ok: true, json: async () => descriptor() });
    job.skipExportToDir = true;
    await m.resumeJob(job.jobId);
    assert.equal(m.sent.length, 1);
    assert.equal(m.sent[0].nzbXml, xml);
    assert.equal(job.state, 'queued');
});

test('worker updates preserve the job object, NZB and folder for later retry', async () => {
    const m = manager();
    const job = { jobId: 'test', nzbXml: xml, dirHandle: { name: 'Downloads' } };
    m.jobs.set(job.jobId, job);
    await m._handleWorkerUpdate(job.jobId, { state: 'downloading', progressPct: 30 });
    assert.equal(m.jobs.get(job.jobId), job);
    assert.equal(job.nzbXml, xml);
    assert.equal(job.dirHandle.name, 'Downloads');
});

test('cancelling removes a job before the worker can persist its final update', async () => {
    const m = manager();
    m.jobs.set('test', { jobId: 'test', state: 'downloading' });
    m.checkpointStore.deleteJob = async () => {};
    m.checkpointStore.saveJob = async () => { throw new Error('Cancelled job must not be saved again'); };
    m.worker = { postMessage: () => {
        assert.equal(m.jobs.has('test'), false);
        m._handleWorkerUpdate('test', { state: 'cancelled' });
    } };
    await m.cancelJob('test');
    assert.equal(m.jobs.size, 0);
});

test('Downloads rows show accessible progress, speed, status, size, ETA and escaped titles', () => {
    const html = manager()._buildJobsListHtml([{ jobId: '1', spotTitle: '<test>', state: 'downloading', progressPct: 25, speedBps: 1024, etaSeconds: 60, totalBytes: 4096, downloadedBytes: 1024 }]);
    assert.match(html, /&lt;test&gt;/);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="25"/);
    assert.match(html, /1.0 KB\/s/);
    assert.match(html, /Downloading/);
    assert.match(html, /01:00/);
    assert.match(html, /data-action="pause"/);
});
