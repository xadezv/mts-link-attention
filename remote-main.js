(function () {
  'use strict';
  const VERSION = 1;
  if (window.__attnMain) return;
  window.__attnMain = VERSION;

  console.log('%c[attention:main v' + VERSION + ']', 'color:#0a8;font-weight:bold', 'активен');
})();
