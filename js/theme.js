/* Shared theme toggle — reads/updates html[data-theme] and persists to localStorage. */
(function () {
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('ct_theme', t); } catch (e) { /* ignore */ }
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.theme-btn');
    if (!btn) return;
    var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    setTheme(cur === 'dark' ? 'light' : 'dark');
  });
})();
