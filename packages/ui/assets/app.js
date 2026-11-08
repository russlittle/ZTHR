// Small enhancements for the Student Advocate. Everything works without this file; it only adds what a browser can't
// do by markup alone. Served from the app's own origin, so the content security policy needs no exception.
(function () {
  'use strict';
  var live = document.createElement('div');
  live.className = 'visually-hidden';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(live); });
  var say = function (text) { live.textContent = ''; setTimeout(function () { live.textContent = text; }, 30); };

  // A form sends once: the button shows it is working and can't be pressed twice.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
    if (form.dataset.sending === '1') { e.preventDefault(); return; }
    form.dataset.sending = '1';
    var btn = e.submitter || form.querySelector('button');
    if (btn) {
      btn.setAttribute('aria-busy', 'true');
      btn.classList.add('busy');
      btn.dataset.label = btn.textContent;
    }
  }, true);
  // Coming back with the browser's back button restores the page as it was; it should be usable again.
  window.addEventListener('pageshow', function () {
    document.querySelectorAll('form[data-sending]').forEach(function (f) { delete f.dataset.sending; });
    document.querySelectorAll('button.busy').forEach(function (b) { b.classList.remove('busy'); b.removeAttribute('aria-busy'); });
  });

  // Copy buttons copy the text of the field they name, and say so.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (!b) return;
    var field = document.getElementById(b.getAttribute('data-copy'));
    if (!field) return;
    var done = function () { b.classList.add('copied'); b.querySelector('.copy-label').textContent = 'Copied'; say('Link copied'); setTimeout(function () { b.classList.remove('copied'); b.querySelector('.copy-label').textContent = 'Copy link'; }, 2400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(field.value).then(done, function () { field.select(); });
    else { field.select(); try { document.execCommand('copy'); done(); } catch (_) { /* the text is selected for copying by hand */ } }
  });

  // The message a tap produced takes focus, so a screen reader reads it first and a keyboard starts from it.
  document.addEventListener('DOMContentLoaded', function () {
    var latest = document.getElementById('latest');
    if (latest && location.hash === '#latest') latest.focus({ preventScroll: false });
  });
})();
