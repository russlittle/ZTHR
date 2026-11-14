// The factory's cost page on a static copy of the site (zthr.ai). The static copy is built without Cloud Build's
// cost history, so the page reads the records the latest build published with the app, and draws them the same
// way the build does. With no answer it says so and links to the app's own copy of the page.
(function () {
  var box = document.getElementById('cost-live');
  if (!box) return;
  var src = box.getAttribute('data-src');
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var kpi = function (v, l) { return '<div class="kpi"><div class="n">' + esc(v) + '</div><div class="l">' + esc(l) + '</div></div>'; };
  fetch(src, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (runs) {
      if (!runs.length) { box.innerHTML = '<p class="muted">No factory runs recorded yet.</p>'; return; }
      var total = 0, mins = 0, month = 0, ym = new Date().toISOString().slice(0, 7);
      runs.forEach(function (c) { total += c.costUsd; mins += c.minutes; if (String(c.finishedAt).slice(0, 7) === ym) month += c.costUsd; });
      var rows = runs.slice(-40).reverse().map(function (c) {
        return '<tr><td>' + esc(String(c.finishedAt).slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(c.kind) + '</td><td>' + esc(c.machine) + '</td><td>' + c.minutes.toFixed(1) + '</td><td>$' + c.costUsd.toFixed(4) + '</td></tr>';
      }).join('');
      box.innerHTML = '<div class="kpis">' + kpi(runs.length.toLocaleString('en-US'), 'factory runs recorded') + kpi('$' + total.toFixed(2), 'all time, list price') + kpi('$' + month.toFixed(2), 'this month, of a $100 cap') + kpi((mins / runs.length).toFixed(1) + ' min', 'average run') + kpi('$0.00', 'model spend by the product') + '</div>' +
        '<div class="panel" style="overflow:auto" tabindex="0" role="region" aria-label="Recent factory runs"><table class="t"><thead><tr><th scope="col">Finished</th><th scope="col">Kind</th><th scope="col">Machine</th><th scope="col">Minutes</th><th scope="col">Cost</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="small muted">Read from the records the latest build published with the app.</p>';
    })
    .catch(function () {
      box.innerHTML = '<p class="muted">The cost records could not be read just now. <a href="' + esc(box.getAttribute('data-page')) + '">The app\'s copy of this page</a> has them.</p>';
    });
})();
