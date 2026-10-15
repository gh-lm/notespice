// GitHub Pages cannot do wildcard redirects, so the old /code/<anything>
// addresses all land on this page. Send those on to /source, which is
// where /code itself goes, and leave every other 404 alone.
(function () {
  var p = window.location.pathname;
  if (p === "/code" || p.indexOf("/code/") === 0) {
    window.location.replace("/source");
  }
})();
