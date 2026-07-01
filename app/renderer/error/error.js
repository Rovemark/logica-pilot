'use strict';

// error.js — friendly error page for failed navigations. Reads ?url/?code/?desc
// from the pilot://error/ URL, maps the Chromium net error to a readable message,
// and offers a Reload that re-navigates the original URL. No inline JS (CSP).

(function () {
  var q = new URLSearchParams(location.search);
  var url = q.get('url') || '';
  var code = parseInt(q.get('code') || '0', 10);
  var desc = q.get('desc') || '';

  // Map common Chromium net error codes to a friendly title + hint.
  function messageFor(c) {
    switch (c) {
      case -105: // ERR_NAME_NOT_RESOLVED
        return ['This site can’t be reached', 'We couldn’t find that address. Check for typos.'];
      case -106: // ERR_INTERNET_DISCONNECTED
        return ['You’re offline', 'Check your internet connection and try again.'];
      case -7:   // ERR_TIMED_OUT
      case -118: // ERR_CONNECTION_TIMED_OUT
        return ['The connection timed out', 'The site took too long to respond.'];
      case -109: // ERR_ADDRESS_UNREACHABLE
      case -102: // ERR_CONNECTION_REFUSED
      case -104: // ERR_CONNECTION_FAILED
        return ['This site can’t be reached', 'The server refused or dropped the connection.'];
      case -501: // ERR_INSECURE_RESPONSE
      case -200: // ERR_CERT_COMMON_NAME_INVALID
      case -201: // ERR_CERT_DATE_INVALID
      case -202: // ERR_CERT_AUTHORITY_INVALID
        return ['Your connection is not private', 'The site’s security certificate is not trusted.'];
      default:
        return ['This page couldn’t be loaded', 'Something went wrong while loading the page.'];
    }
  }

  var m = messageFor(code);
  document.getElementById('title').textContent = m[0];
  document.getElementById('detail').textContent = m[1];
  document.getElementById('url').textContent = url;
  document.getElementById('code').textContent = code
    ? ('Error ' + code + (desc ? ' · ' + desc : ''))
    : (desc || '');

  var reload = document.getElementById('reload');
  reload.addEventListener('click', function () {
    if (url) { try { location.href = url; } catch (e) {} }
  });
  reload.focus();
})();
