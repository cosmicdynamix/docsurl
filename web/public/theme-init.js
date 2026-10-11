// Apply the saved theme before first paint (avoids a dark/light flash). Kept as an external file so the CSP can forbid inline scripts.
(function () {
  try {
    var p = localStorage.getItem('docs_theme') || 'system';
    var t = p === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : p;
    document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
