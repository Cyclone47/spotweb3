/*
 * App shell behaviour for the redesigned modern theme: filter drawer and the
 * bottom navigation bar on tablets and phones. Purely additive; it builds its own
 * markup so the server-side templates do not need to change.
 */
(function () {
  function init() {
    var body = document.body;
    if (!body || !body.classList.contains('modern-theme') || document.querySelector('.sw-bottomnav')) { return; }

    var scrim = document.createElement('div');
    scrim.className = 'sw-drawer-scrim';
    body.appendChild(scrim);

    var nav = document.createElement('nav');
    nav.className = 'sw-bottomnav';
    nav.setAttribute('aria-label', 'Main');
    var ICONS = {
      home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
      filters: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8.5V20l-4-2v-4.5z"/></svg>',
      account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    };
    var items = [
      { id: 'home', label: 'Spots' },
      { id: 'search', label: 'Search' },
      { id: 'filters', label: 'Filters' },
      { id: 'account', label: 'Account' }
    ];
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-nav', it.id);
      b.innerHTML = '<span class="ico">' + ICONS[it.id] + '</span><span>' + it.label + '</span>';
      nav.appendChild(b);
    });
    body.appendChild(nav);

    function drawer(open) { body.classList.toggle('sw-drawer-open', open); }

    scrim.addEventListener('click', function () { drawer(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { drawer(false); } });

    nav.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-nav]');
      if (!btn) { return; }
      switch (btn.getAttribute('data-nav')) {
        case 'home':
          window.location.href = document.baseURI || '/';
          break;
        case 'search':
          drawer(false);
          var input = document.querySelector('#filterform input[type="text"]');
          if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
          break;
        case 'filters':
          drawer(!body.classList.contains('sw-drawer-open'));
          break;
        case 'account':
          drawer(false);
          var acc = document.querySelector('#toolbar .logininfo p a');
          if (acc) { acc.click(); }
          break;
      }
    });

    // Picking a filter in the drawer should close it
    var filter = document.getElementById('filter');
    if (filter) {
      filter.addEventListener('click', function (e) {
        if (e.target.closest('ul.filterlist a[href]')) { drawer(false); }
      });
    }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
