/* Global navigation wiring — extracted from an inline <script> tag so a strict
   Content-Security-Policy can omit 'unsafe-inline' for script-src. */
(function () {
  var brand   = document.getElementById('brandHome');
  var btnHomeQuick = document.getElementById('btnHomeQuick');
  var btnTop  = document.getElementById('btnBackToTop');
  var btnBack = document.getElementById('btnBackHome');
  var sectionLabel = document.getElementById('currentSection');
  var navBar  = document.getElementById('appNav');

  // ---- Section labels (shown in header subtitle) ----
  var SECTION_TITLES = {
    home: 'Home Hub',
    capture: 'New Survey',
    records: 'New Survey · Records',
    map: 'New Survey · Map',
    chief: 'Chief Officer Report',
    leak: 'Leakage Survey',
    pressure: 'Pressure Measurement',
    area: 'Area Survey',
    nrw: 'NRW Report Builder',
    about: 'Help & About',
  };
  // Records/Map routes collapse into NEW SURVEY in the nav bar.
  var NAV_FOR_ROUTE = { records: 'capture', map: 'capture' };

  // ---- Main-panel SURVEY/REPORT/MAP switcher → activate the matching tab ----
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.main-switcher .vs-btn');
    if (!btn) return;
    var route = btn.getAttribute('data-route');
    var navBtn = document.querySelector('.tab[data-tab="' + route + '"]');
    if (navBtn) navBtn.click();
  });

  // ---- Update section label + nav-bar active state on every tab activation ----
  function syncActive(route) {
    if (SECTION_TITLES[route] && sectionLabel) {
      sectionLabel.textContent = SECTION_TITLES[route];
      document.title = 'KUKL · ' + SECTION_TITLES[route];
    }
    var navKey = NAV_FOR_ROUTE[route] || route;
    document.querySelectorAll('.tab[data-tab]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === navKey);
    });
    // Show BACK FAB on every non-home view
    if (btnBack) btnBack.hidden = (navKey === 'home');
    // Auto-scroll the active button into view on small screens
    if (navBar) {
      var active = navBar.querySelector('.tab.active:not([hidden])');
      if (active && active.scrollIntoView) {
        try { active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); } catch (_) {}
      }
    }
  }
  // Hook EVERY tab button (including hidden routing anchors)
  document.querySelectorAll('.tab[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { syncActive(b.getAttribute('data-tab')); });
  });
  syncActive('home');

  // ---- Brand → HOME ----
  function gotoHome(e) {
    if (e) e.preventDefault();
    var t = document.querySelector('.tab[data-tab="home"]');
    if (t) t.click();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
  }
  brand.addEventListener('click', gotoHome);
  if (btnHomeQuick) btnHomeQuick.addEventListener('click', gotoHome);
  if (btnBack)      btnBack.addEventListener('click', gotoHome);

  // ---- Keyboard shortcuts ----
  // Alt+H Home, Alt+N New Survey, Alt+R Records, Alt+M Map,
  // Alt+C/L/P/A field reports, Alt+B NRW, Alt+/ Help.
  var SHORTCUTS = {
    h: 'home',  n: 'capture',  r: 'records',  m: 'map',
    c: 'chief', l: 'leak',     p: 'pressure', a: 'area',
    b: 'nrw',   '/': 'about',
  };
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var key = (e.key || '').toLowerCase();
    var route = SHORTCUTS[key];
    if (!route) return;
    var t = document.querySelector('.tab[data-tab="' + route + '"]');
    if (t) { e.preventDefault(); t.click(); }
  });

  // ---- Back-to-top FAB ----
  function updateFab() {
    if (!btnTop) return;
    var show = (window.scrollY || window.pageYOffset || 0) > 400;
    btnTop.hidden = !show;
  }
  window.addEventListener('scroll', updateFab, { passive: true });
  if (btnTop) btnTop.addEventListener('click', function () {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
  });
  updateFab();
})();
