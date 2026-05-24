/* Theme bootstrap — applied as early as possible to avoid FOUC.
   Extracted from an inline <script> tag so a strict Content-Security-Policy
   can omit 'unsafe-inline' for script-src. */
(function () {
  try {
    var t = localStorage.getItem('kukl-theme') || 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
