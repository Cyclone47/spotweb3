'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the real polling controller without booting the desktop menu/sidebar.
const source = fs.readFileSync(require.resolve('../../templates/modern/js/desktop.js'), 'utf8');
const controller = source.slice(source.indexOf('  function startSyncPolling('), source.indexOf('  /* ---------------------------------------------------------------- sidebar panels */'));
function element() {
    const classes = new Set();
    return { children: [], style: {}, hidden: false, isConnected: true, scrollTop: 0,
        classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
            contains: name => classes.has(name), toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } },
        setAttribute() {}, addEventListener(event, callback) { this[event] = callback; },
        appendChild(child) { this.children.push(child); }, insertBefore(child) { this.children.unshift(child); } };
}
async function test() {
    let clock = 100000, timer, current = element(), notice, swaps = 0, listRequests = 0;
    const body = element(), status = element(), text = element(), prog = element(), bar = element(), refresh = element();
    const parent = { insertBefore(node) { notice = node; }, replaceChild(next) { current = next; next.parentNode = parent; swaps++; } };
    current.parentNode = parent;
    let response = { configured: true, running: true, spots: 0, initialSyncIncomplete: true,
        types: { Spots: { running: true, percent: 0, stage: 'preview' } }, schedule: { running: true, schedulerActive: true } };
    let delayList = false, releaseList;
    const context = {
        M: {}, ML: (key, fallback) => fallback, fmt: String, URLSearchParams,
        Date: class extends Date { static now() { return clock; } },
        document: { body, hidden: false, addEventListener() {} },
        location: { href: 'http://spotweb.test/', search: '', hash: '' }, window: { scrollY: 0 },
        el: (tag, cls, content) => Object.assign(element(), { textContent: content || '' }),
        q: selector => selector === 'div.spots' ? current : null, qa: () => [], buildTabs() {},
        clearTimeout() {}, setTimeout: callback => { timer = callback; return 1; },
        DOMParser: class { parseFromString() { return { querySelector: () => element() }; } },
        fetch: async url => {
            if (url === '?page=syncstatus') return { ok: true, json: async () => response };
            listRequests++;
            return { ok: true, text: () => delayList ? new Promise(resolve => { releaseList = () => resolve('spots'); }) : Promise.resolve('spots') };
        }
    };
    vm.runInNewContext(controller, context);
    context.startSyncPolling(status, text, prog, bar, refresh);
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const poll = async () => { clock += 6000; timer(); await settle(); };
    await settle();
    assert.match(notice.children[0].textContent, /list may be incomplete/);
    assert.match(text.textContent, /Loading recent spots/);
    response.types = { Spots: { running: false, percent: 100 }, Comments: { running: true, percent: 40 } };
    response.run = { phase: 'running', stage: 'comments' };
    await poll();
    assert.match(text.textContent, /Syncing comments 40%/);
    response.run.stage = 'counts';
    await poll();
    assert.match(text.textContent, /Updating spot counts/);
    assert.doesNotMatch(text.textContent, /100%/);
    response.run.stage = 'spots';
    response.types = { Spots: { running: true, percent: 100 } };
    await poll();
    assert.match(text.textContent, /Syncing spots 99%/);
    response.run = { phase: 'done', stage: 'done' };
    response.last = 1000;
    await poll();
    assert.match(text.textContent, /Last checked/);
    assert.equal(refresh.classList.contains('spinning'), false, 'A completed run must stop spinning even before the scheduler next polls');
    response.run = null;
    response.last = 0;
    swaps = 0;
    listRequests = 0;
    response.types = { Spots: { running: true, percent: 0, stage: 'preview' } };
    response.spots = 25;
    await poll();
    assert.equal(swaps, 1, 'Partial spots must load before the sync finishes');

    body.classList.add('spotinfo');
    response.spots = 50;
    await poll();
    assert.equal(listRequests, 1, 'An open spot must prevent automatic list replacement');
    assert.equal(notice.children[1].hidden, false, 'Deferred updates must have a manual update button');
    body.classList.remove('spotinfo');
    context.window.scrollY = 500;
    await poll();
    assert.equal(listRequests, 1, 'Browsing position must not be reset');
    context.window.scrollY = 0;

    delayList = true;
    await poll();
    assert.equal(listRequests, 2);
    body.classList.add('spotinfo');
    releaseList();
    await settle();
    assert.equal(swaps, 1, 'Opening a spot during an in-flight refresh must keep it open');
    body.classList.remove('spotinfo');
    delayList = false;
    await poll();
    assert.equal(swaps, 2, 'Deferred partial updates must resume when browsing is idle');

    response = { configured: true, running: false, spots: 50, initialSyncIncomplete: true, types: {},
        schedule: { running: false, schedulerActive: true, error: 'Provider unavailable' } };
    await poll();
    assert.match(notice.children[0].textContent, /initial sync is incomplete/);
    response.initialSyncIncomplete = false;
    response.schedule.error = null;
    response.schedule.finished = 123;
    await poll();
    await poll();
    assert.equal(notice.hidden, true, 'The incomplete-list notice must clear after successful sync');
    const before = swaps;
    current = element();
    current.parentNode = parent;
    clock += 6000;
    context.startSyncPolling(status, text, prog, bar, refresh);
    await settle();
    assert.equal(swaps, before + 1, 'A sync completed before the first poll must still populate an empty overview');
    console.log('Live sync preview tests passed: partial lists, active spots, scroll position, in-flight updates and completion.');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
