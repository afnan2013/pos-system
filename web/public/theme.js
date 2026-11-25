(function () {
  let saved = null;
  try {
    saved = localStorage.getItem('pos-theme');
  } catch {
    saved = null;
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = saved === 'dark' || (saved !== 'light' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
})();
