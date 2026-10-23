/*
 * Desktop skin: turns the toolbar into an application style menu bar, groups the
 * sidebar into panels (Search, Filters, ...) and adds Overview/Downloads tabs above
 * the details list. It only restructures the existing DOM (the original links and
 * handlers are cloned), and does nothing below the 901px breakpoint.
 */
(function () {
  var L = function (k, d) { return (window.SW_LABELS && window.SW_LABELS[k]) || d; };
  var mq = window.matchMedia ? window.matchMedia('(min-width: 901px)') : { matches: true };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text) { e.textContent = text; }
    return e;
  }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }

  function setView(v) {
    try { localStorage.setItem('spotweb_view', v); } catch (e) {}
    document.cookie = 'spotweb_view=' + v + '; path=/; max-age=' + (60 * 60 * 24 * 365);
    var u = new URL(location.href);
    u.searchParams.set('view', v);
    location.href = u.toString();
  }

  /* ---------------------------------------------------------------- menu bar */
  var M = window.SW_MENU || { file: [], edit: [], labels: {} };
  var ML = function (k, d) { return (M.labels && M.labels[k]) || L(k, d); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  var ACTIONS = {
    refresh: function () {
      if (window.swRequestSync) { window.swRequestSync(); }
    },
    addspot: function (it) {
      if (window.openDialog) { window.openDialog('editdialogdiv', it.label, it.url, function () { if (window.SpotPosting) { new window.SpotPosting().postNewSpot(this.form, window.postSpotUiStart, window.postSpotUiDone); } return false; }, 'autoclose', null, null); }
    },
    login: function () { if (window.openDialog) { window.openDialog('editdialogdiv', M.loginTitle, '?page=login&data[htmlheaderssent]=true', null, 'autoclose', function () { location.reload(); }, null); } },
    adduser: function () { if (window.openDialog) { window.openDialog('editdialogdiv', M.addUserTitle, '?page=createuser', null, 'showresultsonly', null, null); } },
    changeuser: function (it) { if (window.openDialog) { window.openDialog('editdialogdiv', M.changeUserTitle, '?page=edituser&userid=' + it.userid, null, 'autoclose', function () { location.reload(); }, null); } },
    logout: function () { if (window.userLogout) { window.userLogout(); } }
  };

  // columns that can be toggled in the details list
  var COLUMNS = [['genre', 'genre'], ['poster', 'sender'], ['date', 'date'], ['filesize', 'size'], ['comments', 'comments'], ['nzb', 'nzb']];
  function applyColumns() {
    COLUMNS.forEach(function (c) { document.body.classList.toggle('sw-hide-' + c[0], store.get('sw_col_' + c[0], '1') === '0'); });
  }
  function applyFontSize() {
    var n = parseInt(store.get('sw_fontsize', ''), 10);
    if (n) { document.documentElement.style.setProperty('--sw-fs', n + 'px'); }
  }

  function buildMenu(items, ul) {
    items.forEach(function (it) {
      if (it.sep) { ul.appendChild(el('li', 'sep')); return; }
      var li = el('li');
      var a = el('a', null, it.label);
      a.href = it.href || '#';
      if (it.checked) { li.classList.add('checked'); }
      if (it.children) {
        li.classList.add('has-sub');
        var sub = el('ul', 'sw-sub');
        buildMenu(it.children, sub);
        li.appendChild(a);
        li.appendChild(sub);
        a.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
      } else {
        a.addEventListener('click', function (ev) {
          var fn = it.fn || (it.id && ACTIONS[it.id]);
          if (fn) { ev.preventDefault(); fn(it); }
        });
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
  }

  function viewItems() {
    var cur = (new URL(location.href)).searchParams.get('view') || store.get('spotweb_view', 'table');
    var theme = store.get('spotweb_theme', window.SPOTWEB_DEFAULT_THEME || 'auto');
    var fs = parseInt(store.get('sw_fontsize', '14'), 10) || 14;
    return [
      { label: ML('columns', 'Columns'), children: COLUMNS.map(function (c) {
        var on = store.get('sw_col_' + c[0], '1') !== '0';
        return { label: ML(c[1], c[1]), checked: on, fn: function () { store.set('sw_col_' + c[0], on ? '0' : '1'); applyColumns(); } };
      }) },
      { label: ML('fontsize', 'Font size'), children: [12, 13, 14, 15, 16, 18, 20].map(function (n) {
        return { label: n + ' ' + ML('points', 'pt'), checked: n === fs, fn: function () { store.set('sw_fontsize', String(n)); applyFontSize(); } };
      }) },
      { sep: true },
      { label: ML('table', 'Table'), checked: cur === 'table', fn: function () { setView('table'); } },
      { label: ML('cards', 'Cards'), checked: cur === 'cards', fn: function () { setView('cards'); } },
      { sep: true },
      { label: ML('theme', 'Theme'), children: [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']].map(function (t) {
        return { label: ML(t[0], t[1]), checked: theme === t[0], fn: function () { window.SpotwebTheme && window.SpotwebTheme.set(t[0]); } };
      }) }
    ];
  }

  function buildMenubar() {
    var toolbar = document.getElementById('toolbar');
    if (!toolbar || q('.sw-menubar', toolbar)) { return; }

    var bar = el('div', 'sw-menubar');
    var menus = el('ul', 'sw-menus');

    function addMenu(label, items) {
      if (!items || (typeof items !== 'function' && !items.length)) { return; }
      var li = el('li', 'sw-menu');
      var btn = el('button', 'sw-menu-btn', label);
      btn.type = 'button';
      var ul = el('ul', 'sw-menu-list');
      var rebuild = function () { ul.innerHTML = ''; buildMenu(typeof items === 'function' ? items() : items, ul); };
      rebuild();
      li.appendChild(btn);
      li.appendChild(ul);
      menus.appendChild(li);
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var open = li.classList.contains('open');
        qa('.sw-menu.open').forEach(function (m) { m.classList.remove('open'); });
        if (!open) { rebuild(); li.classList.add('open'); }
      });
    }

    addMenu(ML('file', 'File'), M.file);
    addMenu(ML('edit', 'Edit'), M.edit);
    addMenu(ML('view', 'View'), viewItems);
    addMenu(ML('help', 'Help'), [
      { label: ML('documentation', 'Documentation'), href: 'https://github.com/spotweb/spotweb/wiki', fn: function () { window.open('https://github.com/spotweb/spotweb/wiki', '_blank', 'noopener'); } },
      { sep: true },
      { label: ML('about', 'About') + ' Spotweb ' + (M.version || ''), href: '#', fn: function () {} }
    ]);

    var logo = el('a', 'sw-logo');
    logo.href = document.baseURI || '/';
    logo.title = 'Spotweb';
    var logoImg = el('img');
    logoImg.src = (window.spotweb_theme_asset_base || 'templates/modern') + '/img/spotnet-icon-64.png';
    logoImg.alt = 'Spotweb';
    logo.appendChild(logoImg);
    menus.insertBefore(logo, menus.firstChild);
    bar.appendChild(menus);

    // sync indicator (right side): state of the retriever with a progress bar
    var status = el('div', 'sw-status');
    var text = el('a', 'sw-status-text');
    text.href = '#';
    var prog = el('span', 'sw-progress');
    var progBar = el('span', 'sw-progress-bar');
    prog.appendChild(progBar);
    status.appendChild(text);
    status.appendChild(prog);
    var refresh = el('a', 'sw-refresh');
    refresh.title = ML('refresh', 'Refresh');
    refresh.href = '#';
    refresh.addEventListener('click', function (ev) { ev.preventDefault(); ACTIONS.refresh(); });
    status.appendChild(refresh);
    bar.appendChild(status);
    startSyncPolling(status, text, prog, progBar, refresh);

    toolbar.insertBefore(bar, toolbar.firstChild);
    document.addEventListener('click', function () { qa('.sw-menu.open').forEach(function (m) { m.classList.remove('open'); }); });
  }


  /* ---------------------------------------------------------------- sync indicator */
  function fmt(n) { try { return Number(n).toLocaleString(); } catch (e) { return String(n); } }
  function startSyncPolling(status, text, prog, bar, refresh) {
    var timer = null;
    var lastFinished = null;
    var requestPending = false;
    var listLoading = false;
    var lastSpotCount = null;
    var latestSpotCount = 0;
    var lastListRefresh = 0;
    var pendingListRefresh = false;
    var syncNotice = null, noticeMessage = null, noticeButton = null;
    text.setAttribute('role', 'status');
    text.setAttribute('aria-live', 'polite');
    function syncBusy(d) {
      if (d.run && ['done', 'error', 'stalled'].indexOf(d.run.phase) !== -1 && !(d.schedule && d.schedule.queued)) { return false; }
      return !!(d.running || (d.schedule && d.schedule.schedulerActive && (d.schedule.queued || d.schedule.running)));
    }
    function canAutoRefresh() {
      var current = q('div.spots');
      return current && !document.hidden && !location.hash &&
        !document.body.classList.contains('spotinfo') &&
        !current.classList.contains('sw-show-downloads') &&
        !(window.scrollY > 100) && !(current.scrollTop > 100) &&
        !(Number(new URLSearchParams(location.search).get('pagenr')) > 0) &&
        !q('input[type="checkbox"]:checked', current) &&
        !qa('.ui-dialog').some(function (dialog) { return dialog.getClientRects().length > 0; });
    }
    function updateNotice(d, busy) {
      var current = q('div.spots');
      if (!current) { return; }
      if (!syncNotice || !syncNotice.isConnected) {
        syncNotice = el('div', 'sw-sync-notice');
        syncNotice.setAttribute('role', 'status');
        syncNotice.setAttribute('aria-live', 'polite');
        noticeMessage = el('span');
        noticeButton = el('button', null, 'Update list');
        noticeButton.type = 'button';
        noticeButton.addEventListener('click', function () { reloadSpotList(latestSpotCount, false); });
        syncNotice.appendChild(noticeMessage);
        syncNotice.appendChild(noticeButton);
        current.parentNode.insertBefore(syncNotice, current);
      }
      syncNotice.hidden = !(busy || d.initialSyncIncomplete || pendingListRefresh);
      noticeMessage.textContent = busy
        ? 'Sync in progress. This list may be incomplete. You can open the available spots while more are added.'
        : (d.initialSyncIncomplete
          ? 'The initial sync is incomplete. You can open available spots; use Refresh above to resume syncing.'
          : 'More spots are available. Update the list when you are ready.');
      noticeButton.hidden = !pendingListRefresh;
    }
    function reloadSpotList(spotCount, automatic) {
      var current = q('div.spots');
      if (!current || listLoading) { return; }
      listLoading = true;
      fetch(location.href.split('#')[0], { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { if (!r.ok) { throw new Error('Could not refresh the spot list'); } return r.text(); })
        .then(function (html) {
          // A spot may have been opened while the list request was in flight.
          if (automatic && !canAutoRefresh()) { return; }
          var next = new DOMParser().parseFromString(html, 'text/html').querySelector('div.spots');
          if (!next) { throw new Error('Could not refresh the spot list'); }
          qa('script', next).forEach(function (script) { script.remove(); });
          // Preserve the download panel and its worker while updating the overview.
          var existingTabs = q('.sw-tabs', current);
          var existingDownloads = q('#sw-browser-downloads', current);
          if (existingTabs) { next.insertBefore(existingTabs, next.firstChild); }
          if (existingDownloads) { next.appendChild(existingDownloads); }
          if (current.classList.contains('sw-show-downloads')) { next.classList.add('sw-show-downloads'); }
          current.parentNode.replaceChild(next, current);
          if (window.jQuery) {
            var links = window.jQuery(next).find('a.spotlink');
            links.click(function (ev) { ev.preventDefault(); });
            if (links.address) { links.address(); }
            if (window.applyTipTip) { window.jQuery(next).find('.showTipTip a.spotlink').each(window.applyTipTip); }
            if (window.attachInfiniteScroll) { window.attachInfiniteScroll(); }
          }
          buildTabs();
          lastSpotCount = typeof spotCount === 'number' ? spotCount : latestSpotCount;
          lastListRefresh = Date.now();
          pendingListRefresh = false;
        }).catch(function (err) { text.textContent = err.message; })
        .then(function () { listLoading = false; });
    }
    window.swRequestSync = function () {
      if (requestPending) { return; }
      if (!M.syncToken) {
        text.textContent = 'Refreshing the spot list';
        reloadSpotList();
        return;
      }
      requestPending = true;
      refresh.classList.add('spinning');
      text.textContent = 'Checking for new spots…';
      fetch('?page=syncstatus', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'syncform[submitretrieve]=1&syncform[xsrfid]=' + encodeURIComponent(M.syncToken)
      }).then(function (r) {
        return r.json().then(function (d) { if (!r.ok || !d.ok) { throw new Error(d.error || 'Could not start retrieval'); } });
      }).then(function () { poll(); })
        .catch(function (err) { text.textContent = err.message; refresh.classList.remove('spinning'); })
        .then(function () { requestPending = false; });
    };
    function when(ts) {
      try { return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return new Date(ts * 1000).toLocaleString(); }
    }
    function render(d) {
      status.classList.remove('is-running', 'is-idle', 'is-none');
      prog.classList.remove('indeterminate');
      text.onclick = function (ev) { ev.preventDefault(); };
      if (!d.configured) {
        status.classList.add('is-none');
        text.textContent = ML('nosync', 'No Usenet server configured');
        text.href = '?page=editsettings&tab=2';
        text.onclick = null;
        bar.style.width = '0';
        return;
      }
      text.href = '#';
      var spots = ML('spotsn', 'spots');
      if (d.run && d.run.phase === 'stalled' && !(d.schedule && d.schedule.queued)) {
        text.textContent = 'Sync stopped responding. Check the retrieval log.';
        bar.style.width = '0';
        return;
      }
      if (d.schedule && d.schedule.error && !d.running && !d.schedule.queued) {
        text.textContent = d.schedule.error;
        return;
      }
      if (d.schedule && d.schedule.queued && !d.running) {
        text.textContent = 'Waiting to check for new spots…';
        return;
      }
      if (d.run && d.run.phase === 'error') {
        text.textContent = 'Sync failed. Check the retrieval log.';
        bar.style.width = '0';
        return;
      }
      if (syncBusy(d)) {
        status.classList.add('is-running');
        var active = d.types && ['Spots', 'Comments', 'Reports'].map(function (name) { return { name: name, data: d.types[name] }; })
          .filter(function (type) { return type.data && type.data.running; })[0];
        var stage = d.run && d.run.phase === 'running' ? d.run.stage : (active ? active.name.toLowerCase() : 'finishing');
        var stream = active && active.name.toLowerCase() === stage;
        var pct = stream ? Math.min(99, active.data.percent) : 0;
        var labels = { starting: 'Starting sync', retention: 'Cleaning old spots', spots: 'Syncing spots',
          counts: 'Updating spot counts', comments: 'Syncing comments', reports: 'Syncing reports',
          cleanup: 'Finishing sync', blocklists: 'Updating blocklists', statistics: 'Updating statistics',
          notifications: 'Sending notifications', finishing: 'Finishing sync' };
        if (!pct) { prog.classList.add('indeterminate'); bar.style.width = ''; } else { bar.style.width = pct + '%'; }
        text.textContent = (active && active.data.stage === 'preview' && stage === 'spots' ? 'Loading recent spots' : (labels[stage] || ML('syncing', 'Syncing'))) +
          (pct ? ' ' + pct + '%' : '...') + ' \u00B7 ' + fmt(d.spots) + ' ' + spots;
      } else {
        status.classList.add('is-idle');
        bar.style.width = '0';
        text.textContent = d.last
          ? 'Last checked ' + when(d.last) + ' \u00B7 ' + fmt(d.spots) + ' ' + spots
          : ML('waitfirst', 'Waiting for first sync') + ' \u00B7 ' + fmt(d.spots) + ' ' + spots;
      }
    }
    function poll() {
      fetch('?page=syncstatus', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) { schedule(30000); return; }
          M.syncToken = d.syncToken || null;
          render(d);
          latestSpotCount = Number(d.spots) || 0;
          var busy = syncBusy(d);
          if (lastSpotCount === null) {
            lastSpotCount = latestSpotCount;
            // The first run can finish between rendering an empty overview and
            // receiving this first status response. Load those spots as well.
            if (latestSpotCount > 0 && (busy || (q('div.spots') && !q('a.spotlink', q('div.spots'))))) {
              pendingListRefresh = true;
            }
          } else if (lastSpotCount !== latestSpotCount) { pendingListRefresh = true; }
          var finished = d.schedule && d.schedule.finished || d.last;
          if (lastFinished !== null && finished > lastFinished) { pendingListRefresh = true; }
          lastFinished = Math.max(lastFinished || 0, finished || 0);
          if (pendingListRefresh && canAutoRefresh() && Date.now() - lastListRefresh >= 5000) {
            reloadSpotList(latestSpotCount, true);
          }
          updateNotice(d, busy);
          refresh.classList.toggle('spinning', !!busy);
          schedule(busy ? 2000 : 20000);
        })
        .catch(function () { schedule(30000); });
    }
    function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { poll(); } });
    window.swSyncNow = poll;
    poll();
  }

  /* ---------------------------------------------------------------- sidebar panels */
  function panel(title, bodyNodes, opts) {
    opts = opts || {};
    var p = el('section', 'sw-panel' + (opts.cls ? ' ' + opts.cls : ''));
    var head = el('div', 'sw-panel-head');
    head.appendChild(el('span', 'sw-panel-title', title));
    var tog = el('button', 'sw-panel-toggle');
    tog.type = 'button';
    tog.setAttribute('aria-label', 'Toggle');
    head.appendChild(tog);
    head.addEventListener('click', function () { p.classList.toggle('collapsed'); });
    var body = el('div', 'sw-panel-body');
    bodyNodes.forEach(function (n) { if (n) { body.appendChild(n); } });
    p.appendChild(head);
    p.appendChild(body);
    if (opts.collapsed) { p.classList.add('collapsed'); }
    return p;
  }

  function buildSidebar() {
    var filter = document.getElementById('filter');
    var form = document.getElementById('filterform');
    if (!filter || filter.classList.contains('sw-built')) { return; }
    filter.classList.add('sw-built');

    var quick = q('ul.quicklinks', filter);
    var filters = q('ul.filters', filter);
    var maint = q('ul.maintenancebox', filter);
    qa('a.viewState', filter).forEach(function (a) { a.style.display = 'none'; });

    // ---- search panel: radios + text box + "extended" + "filter"
    var searchBody = [];
    if (form) {
      var types = q('.advancedSearch ul.search.fourcol', form);
      if (types) {
        var tw = el('div', 'sw-searchtypes');
        tw.appendChild(types);
        qa('li', types).forEach(function (li) {
          var r = q('input[type=radio]', li);
          var lab = q('label', li);
          if (r && lab) { var id = 'sw-st-' + r.value; r.id = id; lab.setAttribute('for', id); }
        });
        searchBody.push(tw);
      }
      var box = q('.search', form);
      if (box) { searchBody.push(box); }
      var opts = el('div', 'sw-searchopts');
      var ext = el('label', 'sw-check');
      var extCb = el('input'); extCb.type = 'checkbox';
      ext.appendChild(extCb); ext.appendChild(document.createTextNode(' ' + L('extended', 'Extended')));
      extCb.addEventListener('change', function () { if (window.toggleSidebarPanel) { window.toggleSidebarPanel('.advancedSearch'); } });
      var advPanel = q('.advancedSearch', form);
      if (advPanel && window.MutationObserver) {
        new MutationObserver(function () { extCb.checked = advPanel.offsetWidth > 0 && advPanel.style.display !== 'none'; })
          .observe(advPanel, { attributes: true, attributeFilter: ['style'] });
      }
      var inc = el('label', 'sw-check');
      var incCb = el('input'); incCb.type = 'checkbox';
      inc.appendChild(incCb); inc.appendChild(document.createTextNode(' ' + L('filter', 'Filter')));
      incCb.addEventListener('change', function () {
        var h = document.getElementById('searchfilter-includeprevfilter-toggle');
        if (h) { h.value = incCb.checked ? 'true' : ''; }
      });
      opts.appendChild(ext); opts.appendChild(inc);
      searchBody.push(opts);
      // the '+' submit is replaced by the "Filter" checkbox
      qa('input.filtersubmit:not(.default)', form).forEach(function (b) { b.style.display = 'none'; });
      qa('input.filtersubmit.default', form).forEach(function (b) { b.value = ''; b.title = L('search', 'Search'); });
      form.classList.add('sw-searchform');
      // keep the full form (incl. the hidden advanced panel) in the DOM, wrapped in the panel
      form.insertBefore(el('div', 'sw-form-anchor'), form.firstChild);
      var anchor = q('.sw-form-anchor', form);
      searchBody.forEach(function (n) { anchor.appendChild(n); });
    }

    var searchPanel = form ? (function () {
      var p = el('section', 'sw-panel sw-panel-search');
      var head = el('div', 'sw-panel-head');
      head.appendChild(el('span', 'sw-panel-title', L('search', 'Search')));
      var tog = el('button', 'sw-panel-toggle'); tog.type = 'button'; head.appendChild(tog);
      head.addEventListener('click', function () { p.classList.toggle('collapsed'); });
      var body = el('div', 'sw-panel-body');
      body.appendChild(form);
      p.appendChild(head); p.appendChild(body);
      return p;
    })() : null;

    // ---- filters panel: quicklinks + category list
    var filtersPanel = panel(L('filters', 'Filters'), [quick, filters]);

    // ---- add-filter panel (opens the filter dialog)
    var addLink = q('.advancedSearch a[onclick*="editfilter"]', document);
    var addPanel = null;
    if (addLink) {
      var a = el('a', 'sw-addfilter', L('addfilter', 'Add a filter'));
      a.href = '#';
      a.addEventListener('click', function (ev) { ev.preventDefault(); addLink.click(); });
      addPanel = panel(L('addfilter', 'Add a filter'), [a], { collapsed: true, cls: 'sw-panel-add' });
    }
    var maintPanel = maint ? panel(L('maintenance', 'Maintenance'), [maint], { collapsed: true }) : null;

    while (filter.firstChild) { filter.removeChild(filter.firstChild); }
    [searchPanel, filtersPanel, addPanel, maintPanel].forEach(function (p) { if (p) { filter.appendChild(p); } });

    // sub categories start collapsed, like a tree view
    qa('ul.subfilterlist', filters).forEach(function (ul) { ul.style.display = 'none'; });
  }

  /* ---------------------------------------------------------------- tabs above the list */
  function buildTabs() {
    var spots = q('div.spots');
    if (!spots || q('.sw-tabs', spots)) { return; }
    var tabs = el('div', 'sw-tabs');
    var dl = q('#filter a.filter[href*="Downloaded"]');
    var isDl = /Downloaded/.test(decodeURIComponent(location.search));

    var o = el('a', 'sw-tab' + (isDl ? '' : ' active'), L('overview', 'Overview'));
    o.href = '?search[tree]=&search[unfiltered]=true';
    tabs.appendChild(o);
    var d = el('a', 'sw-tab sw-tab-downloads', L('downloads', 'Downloads'));
    d.href = '#downloads';
    var badge = el('span', 'sw-dl-badge');
    badge.id = 'sw-nav-dl-badge';
    badge.style.display = 'none';
    d.appendChild(badge);
    d.addEventListener('click', function (ev) {
      if (window.spotwebBrowserDownloadManager) {
        ev.preventDefault();
        window.spotwebBrowserDownloadManager.openDownloadsPanel();
      } else if (dl) { window.location.href = dl.href; }
    });
    tabs.appendChild(d);
    o.addEventListener('click', function () {
      if (window.spotwebBrowserDownloadManager) window.spotwebBrowserDownloadManager.closeDownloadsPanel();
    });
    spots.insertBefore(tabs, spots.firstChild);
  }

  // ?tab=N opens the Nth tab of a settings/preferences page
  function openRequestedTab() {
    var n = parseInt((new URL(location.href)).searchParams.get('tab'), 10);
    if (!n || !q('.ui-tabs-nav')) { return; }
    var a = q('.ui-tabs-nav li:nth-child(' + n + ') a');
    if (a) { setTimeout(function () { a.click(); }, 350); }
  }

  function init() {
    if (!document.body || !document.body.classList.contains('modern-theme')) { return; }
    qa('time[data-local-time]').forEach(function (time) {
      time.textContent = new Date(Number(time.getAttribute('data-local-time')) * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    });
    if (!mq.matches) { return; }
    document.body.classList.add('sw-desktop');
    applyColumns();
    applyFontSize();
    // The legacy script pops the advanced search panel open whenever the search box gets focus;
    // in this skin it is only opened through the "Extended" checkbox.
    if (window.jQuery) { window.jQuery('input.searchbox').off('focus'); }
    qa('input.searchbox').forEach(function (i) { i.setAttribute('autocomplete', 'off'); });
    buildMenubar();
    if (document.getElementById('filter')) { buildSidebar(); }
    buildTabs();
    watchSpotTab();
    openRequestedTab();
  }

  /* ---------------------------------------------------------------- tab for the opened spot */
  function syncSpotTab() {
    var tabs = q('.sw-tabs');
    if (!tabs) { return; }
    if (window.spotwebBrowserDownloadManager && window.spotwebBrowserDownloadManager.panelOpen) {
      qa('.sw-tab', tabs).forEach(function(t) { t.classList.toggle('active', t.classList.contains('sw-tab-downloads')); });
      var stale = q('.sw-tab-spot', tabs);
      if (stale) stale.remove();
      return;
    }
    var open = document.body.classList.contains('spotinfo') && !!q('#overlay #details');
    var tab = q('.sw-tab-spot', tabs);
    if (!open) {
      if (tab) { tab.parentNode.removeChild(tab); }
      var ov = q('.sw-tab', tabs);
      if (ov && !q('.sw-tab.active', tabs)) { ov.classList.add('active'); }
      return;
    }
    var title = (q('#overlay #details .spottitle') || {}).textContent || '';
    if (!tab) {
      tab = el('a', 'sw-tab sw-tab-spot active');
      tab.href = '#';
      tab.appendChild(el('span', 'sw-tab-title'));
      var x = el('span', 'sw-tab-x', '\u00D7');
      x.title = ML('close', 'Close');
      x.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var back = q('#overlay a.closeDetails');
        if (back) { back.click(); }
      });
      tab.appendChild(x);
      tab.addEventListener('click', function (ev) { ev.preventDefault(); });
      tabs.appendChild(tab);
    }
    q('.sw-tab-title', tab).textContent = title.trim();
    qa('.sw-tab', tabs).forEach(function (t) { if (t !== tab) { t.classList.remove('active'); } });
  }

  function watchSpotTab() {
    if (!window.MutationObserver) { return; }
    var mo = new MutationObserver(syncSpotTab);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    var ov = document.getElementById('overlay');
    if (ov) { mo.observe(ov, { childList: true, subtree: true }); }
  }

  // after the list was swapped in place (seamless navigation)
  document.addEventListener('sw:listswap', function () {
    if (!document.body.classList.contains('sw-desktop')) { return; }
    buildTabs();
    syncSpotTab();
    var checks = qa('.sw-searchopts .sw-check input');
    if (checks[1]) { checks[1].checked = false; }
  });

  if (mq.addEventListener) {
    mq.addEventListener('change', function () { location.reload(); });
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
