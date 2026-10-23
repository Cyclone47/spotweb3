/*
 * Seamless list navigation: clicking a filter, sort header, pager link, tab or
 * submitting a search fetches the new list in the background and swaps only the list
 * (div.spots). Menu bar, sidebar and scroll containers stay in place; the address bar
 * is updated with the History API so Back/Forward keep working. Anything this script
 * does not recognise falls back to a normal page load.
 */
(function () {
  if (!window.fetch || !window.history || !history.pushState || !window.DOMParser || !window.AbortController) { return; }

  var token = 0;
  var controller = null;
  var lastList = null; // URL (without hash) of the list that is currently shown

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
  function listRoot(doc) { return q('div.spots', doc || document); }
  function noHash(u) { var x = new URL(u, document.baseURI); x.hash = ''; return x.toString(); }

  function onListPage() {
    return !!listRoot() && !document.body.classList.contains('spotinfo-page');
  }

  // a spot opened in the overlay: close it so the list underneath can be replaced
  function closeSpotOverlay() {
    if (document.body.classList.contains('spotinfo') && typeof window.closeDetails === 'function') {
      try { if (window.jQuery) { window.jQuery.address.value(''); } window.closeDetails(0); } catch (e) {}
    }
  }

  /* ----------------------------------------------------------- what may be intercepted */
  function isListUrl(u) {
    if (u.origin !== location.origin) { return false; }
    if (u.pathname !== location.pathname) { return false; }
    var page = u.searchParams.get('page');
    return page === null || page === '' || page === 'index';
  }

  function eligibleLink(a, ev) {
    if (!a || !a.getAttribute) { return false; }
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) { return false; }
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) { return false; }
    if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('onclick')) { return false; }
    if (a.classList.contains('external') || a.classList.contains('spotlink')) { return false; }
    if (!a.closest('#filter, div.spots, .sw-tabs')) { return false; }
    var u;
    try { u = new URL(a.href, document.baseURI); } catch (e) { return false; }
    return isListUrl(u);
  }

  /* ----------------------------------------------------------- navigation */
  function withView(u) {
    // keep the list view (table/cards) the same when the link does not say
    if (!u.searchParams.has('view')) {
      var v = new URL(location.href).searchParams.get('view');
      if (v) { u.searchParams.set('view', v); }
    }
    return u;
  }

  function navigate(target, push) {
    var u = withView(new URL(target, document.baseURI));
    var id = ++token;
    if (controller) { controller.abort(); }
    controller = new AbortController();
    document.body.classList.add('sw-navigating');

    return fetch(u.toString(), { credentials: 'same-origin', signal: controller.signal, headers: { 'X-Requested-With': 'spotweb-nav' } })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (!r.ok || type.indexOf('html') < 0 || /[?&]page=(setup|login)/.test(r.url)) { throw new Error('not-a-list'); }
        return r.text();
      })
      .then(function (html) {
        if (id !== token) { return; }
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = listRoot(doc);
        if (!fresh) { throw new Error('no-list'); }
        swap(doc, fresh, u, push);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') { return; }
        window.location.href = u.toString(); // anything unexpected: plain page load
      })
      .then(function () { if (id === token) { document.body.classList.remove('sw-navigating'); } });
  }

  function swap(doc, fresh, u, push) {
    var cur = listRoot();
    cur.parentNode.replaceChild(document.importNode(fresh, true), cur);
    if (doc.title) { document.title = doc.title; }

    if (push) { history.pushState({ swNav: 1 }, '', u.toString()); } else { history.replaceState({ swNav: 1 }, '', u.toString()); }
    lastList = noHash(u.toString());

    syncSidebar(doc, u);
    reinitList();
    if (push) { window.scrollTo(0, 0); }
    document.dispatchEvent(new CustomEvent('sw:listswap', { detail: { url: u.toString() } }));
  }

  /* ----------------------------------------------------------- keep sidebar / search in sync */
  function norm(href) {
    var x = new URL(href, document.baseURI);
    var p = new URLSearchParams(x.search);
    ['view', 'direction', 'pagenr'].forEach(function (k) { p.delete(k); });
    p.sort();
    return x.pathname + '?' + p.toString();
  }

  function syncSidebar(doc, u) {
    var here = norm(u.toString());
    var fresh = {};
    qa('#filter a.filter', doc).forEach(function (a) { fresh[a.getAttribute('href')] = a; });

    qa('#filter a.filter').forEach(function (a) {
      if (!a.classList.contains('external')) { a.classList.toggle('selected', norm(a.href) === here); }
      // "new spots" counters
      var n = fresh[a.getAttribute('href')];
      var cur = q('.newspots', a);
      var nw = n && q('.newspots', n);
      if (nw) {
        if (cur) { cur.textContent = nw.textContent; } else { a.insertBefore(nw.cloneNode(true), q('.toggle, .inclusive', a)); }
      } else if (cur) { cur.parentNode.removeChild(cur); }
    });

    var form = document.getElementById('filterform');
    var nform = doc.getElementById('filterform');
    if (!form || !nform) { return; }

    // the active text filters travel along as hidden inputs
    qa('[data-currentfilter="true"]', form).forEach(function (e) { e.parentNode.removeChild(e); });
    var treeEl = q('#search-tree', form);
    var treeHolder = treeEl && treeEl.parentNode !== form ? treeEl.parentNode : treeEl;
    qa('[data-currentfilter="true"]', nform).forEach(function (e) {
      var c = e.cloneNode(true);
      if (treeHolder && treeHolder.parentNode === form) { form.insertBefore(c, treeHolder); } else { form.appendChild(c); }
    });
    var nTree = q('#search-tree', nform);
    if (treeEl && nTree) { treeEl.value = nTree.value; }

    var box = q('input.searchbox', form), nbox = q('input.searchbox', nform);
    if (box && nbox) { box.value = nbox.value; }
    qa('input[name="search[type]"]', form).forEach(function (r) {
      var m = q('input[name="search[type]"][value="' + r.value + '"]', nform);
      if (m) { r.checked = m.checked; }
    });
    var toggle = document.getElementById('searchfilter-includeprevfilter-toggle');
    if (toggle) { toggle.value = ''; }
  }

  function reinitList() {
    if (!window.jQuery) { return; }
    var $ = window.jQuery;
    $('a.spotlink').off('click.swnav').on('click.swnav', function (e) { e.preventDefault(); });
    if (window.applyTipTip) { $('.showTipTip a.spotlink').each(window.applyTipTip); }
    $("div.spots a[href^='http']").attr('target', '_blank');
  }

  /* ----------------------------------------------------------- search form -> URL */
  function searchUrl(form) {
    var el = form.elements;
    var text = (el['search[text]'] ? el['search[text]'].value : '').trim();
    var typeEl = form.querySelector('input[name="search[type]"]:checked');
    var include = (document.getElementById('searchfilter-includeprevfilter-toggle') || {}).value === 'true';
    var params = new URLSearchParams();

    qa('input, select, textarea', form).forEach(function (e) {
      var name = e.name;
      if (!name || e.disabled) { return; }
      var type = (e.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'file') { return; }
      if ((type === 'checkbox' || type === 'radio') && !e.checked) { return; }
      if (name === 'search[text]' || name === 'search[type]' || name === 'search[includeinfilter]') { return; }
      if (e.hasAttribute('data-currentfilter') && !include) { return; }
      var v = e.value;
      if (name === 'search[value][]') {
        if (v === '') { return; }
        if (e.id === 'min-filesize' && v === 'filesize:>:DEF:0') { return; }
        if (e.id === 'max-filesize' && v === 'filesize:<:DEF:274877906944') { return; }
        if (e.id === 'max-reportcount' && v === 'reportcount:<=:21') { return; }
      }
      params.append(name, v);
    });
    if (text.length > 0) { params.append('search[value][]', (typeEl ? typeEl.value : 'Title') + ':=:DEF:' + text); }

    var u = new URL(form.getAttribute('action') || location.pathname, document.baseURI);
    u.search = '';
    params.forEach(function (v, k) { u.searchParams.append(k, v); });
    return u;
  }

  /* ----------------------------------------------------------- events */
  document.addEventListener('click', function (ev) {
    if (!onListPage()) { return; }
    var a = ev.target.closest ? ev.target.closest('a') : null;
    if (!eligibleLink(a, ev)) { return; }
    ev.preventDefault();
    closeSpotOverlay();
    navigate(a.href, true);
  });

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || form.id !== 'filterform' || !onListPage()) { return; }
    var u = searchUrl(form);
    if (!isListUrl(u)) { return; }
    ev.preventDefault();
    ev.stopImmediatePropagation(); // the legacy handler would strip inputs from the live form
    closeSpotOverlay();
    navigate(u.toString(), true);
  }, true);

  window.addEventListener('popstate', function (ev) {
    if (!ev.state || !ev.state.swNav) { return; }
    if (noHash(location.href) === lastList) { return; } // hash-only change (spot overlay)
    if (!onListPage()) { return; }
    navigate(location.href, false);
  });

  function init() {
    if (!onListPage()) { return; }
    lastList = noHash(location.href);
    history.replaceState({ swNav: 1 }, '', location.href);
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }

  window.swNavigate = function (url) { return navigate(url, true); };
})();
