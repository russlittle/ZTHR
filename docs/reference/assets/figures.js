/*
 * Figures: every diagram and table on the published pages fits the column it sits in, so nothing on a page ever
 * scrolls sideways. Each one carries controls at its top right: full screen (where it can be zoomed and moved),
 * copy (a diagram as an image, a table as rows that paste into a spreadsheet) and print (that figure alone).
 * On a phone, left-to-right flowcharts are drawn top to bottom, and a table too wide for the screen restacks into
 * one block per row, each value labelled with its column.
 */
(function () {
  'use strict';
  var dark = matchMedia('(prefers-color-scheme: dark)').matches;
  var narrow = innerWidth < 700;

  var ICON = {
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    print: '<path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2"/><rect x="7" y="14" width="10" height="6"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    minus: '<path d="M6 12h12"/>',
    fit: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><rect x="9" y="9" width="6" height="6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON[name] + '</svg>';
  }
  function button(label, name, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'fig-btn';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon(name);
    b.addEventListener('click', onClick);
    return b;
  }

  // One polite live region for "copied" and similar news.
  var live = document.createElement('div');
  live.className = 'fig-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  function say(text) {
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 30);
  }

  var css = [
    '.fig{position:relative;margin:14px 0;max-width:100%;min-width:0}',
    '.fig-bar{display:flex;justify-content:flex-end;gap:4px;margin:0 0 4px}',
    '.fig-btn{display:inline-grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid var(--line,#c8d6de);border-radius:8px;background:var(--surface,#fff);color:inherit;cursor:pointer}',
    '.fig-btn:hover{background:var(--calm,#eef3f5)}',
    '.fig-btn:focus-visible{outline:3px solid var(--accent,#0b6680);outline-offset:2px}',
    '.fig .mermaid{overflow:hidden!important;margin:0}',
    '.fig>.diagram{margin:0}',
    '.fig .mermaid svg,.fig .diagram>svg,.fig>svg{max-width:100%!important;min-width:0!important;width:100%;height:auto;cursor:zoom-in}',
    // Long names (file paths, identifiers) in headings and summaries break rather than push the page wider.
    'main summary,main summary *,main h1,main h2,main h3,main td{overflow-wrap:break-word}',
    '.fig .fig-host{overflow:visible!important;margin:0!important}',
    '.fig table{margin:0}',
    '.fig-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    // Code and menus wrap rather than scroll.
    '.prose pre,pre:not(.mermaid){white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden}',
    '.prose code{overflow-wrap:anywhere}',
    // A table too wide for the screen restacks: one block per row, each value labelled with its column.
    '@media screen{.fig.stack table,.fig.stack thead,.fig.stack tbody,.fig.stack tr,.fig.stack th,.fig.stack td{display:block;width:auto}',
    '.fig.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
    '.fig.stack tr{border:1px solid var(--line,#c8d6de);border-radius:10px;padding:6px 10px;margin:0 0 8px;background:var(--surface,transparent)}',
    '.fig.stack td{border:0!important;padding:4px 0!important;overflow-wrap:break-word}',
    '.fig.stack table{min-width:0!important;max-width:100%}',
    '.fig.stack td *{white-space:normal!important;overflow-wrap:anywhere}',
    '.panel:has(>.fig){overflow:visible!important}',
    '.fig.stack td[data-label]::before{content:attr(data-label);display:block;font-size:.8em;font-weight:700;opacity:.75;margin-bottom:1px}}',
    // Full screen view.
    '.fig-view{position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--bg,' + (dark ? '#0f171c' : '#f6f9fa') + ');color:inherit;display:grid;grid-template-rows:auto 1fr}',
    '.fig-view:not([open]){display:none}',
    '.fig-view::backdrop{background:rgba(0,0,0,.5)}',
    '.fig-view header{display:flex;align-items:center;gap:6px;padding:max(8px,env(safe-area-inset-top,0px)) max(12px,env(safe-area-inset-right,0px)) 8px max(12px,env(safe-area-inset-left,0px));border-bottom:1px solid var(--line,#c8d6de);background:var(--surface,#fff)}',
    '.fig-view h2{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fig-zoom{min-width:3.5em;text-align:center;font-variant-numeric:tabular-nums;font-size:14px}',
    '.fig-stage{position:relative;overflow:hidden;touch-action:none;cursor:grab}',
    '.fig-stage.drag{cursor:grabbing}',
    '.fig-content{position:absolute;left:0;top:0;transform-origin:0 0;background:var(--surface,#fff);padding:16px;border-radius:12px}',
    '.fig-content svg{max-width:none!important;display:block}',
    '.fig-content table{width:max-content;max-width:none}',
    // Print: the chosen figure alone, at the width of the page.
    // On a narrow screen the title takes its own line, so every control, Close included, always fits.
    '.fig-view header{flex-wrap:wrap}',
    '@media (max-width:560px){.fig-view h2{flex-basis:100%;white-space:normal}.fig-view header>.fig-btn:nth-of-type(3){margin-left:auto}}',
    '@media print{html.fig-printing body *{visibility:hidden!important}html.fig-printing .fig-print,html.fig-printing .fig-print *{visibility:visible!important}html.fig-printing .fig-print{position:absolute;left:0;top:0;width:100%}.fig-bar,.fig-view{display:none!important}.fig .mermaid svg{max-width:100%!important}}',
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function titleOf(fig) {
    var cap = fig.querySelector('caption');
    if (cap && cap.textContent.trim()) return cap.textContent.trim();
    var h = null;
    for (var el = fig.previousElementSibling; el && !h; el = el.previousElementSibling) if (/^H[1-4]$/.test(el.tagName)) h = el;
    if (!h) {
      var heads = document.querySelectorAll('main h2, main h3, article h2, article h3');
      for (var i = 0; i < heads.length; i++) if (heads[i].compareDocumentPosition(fig) & Node.DOCUMENT_POSITION_FOLLOWING) h = heads[i];
    }
    return (h ? h.textContent.trim() + ': ' : '') + (fig.dataset.kind === 'diagram' ? 'diagram' : 'table');
  }

  // ---- Copy ----
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { say(done); }, function () { say('Copy is not allowed here; select and copy instead.'); });
    else say('Copy is not available in this browser.');
  }
  function svgImage(svg, scale, cb) {
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var w = (vb && vb.width) || svg.getBoundingClientRect().width;
    var h = (vb && vb.height) || svg.getBoundingClientRect().height;
    var clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    clone.removeAttribute('style');
    var bg = getComputedStyle(svg.closest('.mermaid') || svg).backgroundColor;
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = Math.ceil(w * scale);
      c.height = Math.ceil(h * scale);
      var x = c.getContext('2d');
      x.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : dark ? '#111e25' : '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
      x.scale(scale, scale);
      x.drawImage(img, 0, 0, w, h);
      try {
        c.toBlob(function (b) { cb(b, clone.outerHTML); }, 'image/png');
      } catch (e) {
        cb(null, clone.outerHTML);
      }
    };
    img.onerror = function () { cb(null, clone.outerHTML); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  }
  function copyFigure(fig) {
    if (fig.dataset.kind === 'diagram') {
      var svg = fig._src();
      if (!svg) return;
      svgImage(svg, 2, function (png, svgText) {
        if (png && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(function () { say('Diagram copied as an image.'); }, function () { copyText(svgText, 'Diagram copied as SVG.'); });
        } else copyText(svgText, 'Diagram copied as SVG.');
      });
      return;
    }
    var table = fig.querySelector('table');
    var rows = Array.prototype.map.call(table.rows, function (r) {
      return Array.prototype.map.call(r.cells, function (c) { return c.innerText.replace(/\s+/g, ' ').trim(); }).join('\t');
    }).join('\n');
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      navigator.clipboard
        .write([new ClipboardItem({ 'text/plain': new Blob([rows], { type: 'text/plain' }), 'text/html': new Blob([table.outerHTML], { type: 'text/html' }) })])
        .then(function () { say('Table copied; it pastes into a spreadsheet as rows and columns.'); }, function () { copyText(rows, 'Table copied.'); });
    } else copyText(rows, 'Table copied.');
  }

  // ---- Print ----
  function printFigure(fig) {
    if (view.open) closeView();
    fig.classList.add('fig-print');
    document.documentElement.classList.add('fig-printing');
    var undo = function () {
      fig.classList.remove('fig-print');
      document.documentElement.classList.remove('fig-printing');
      removeEventListener('afterprint', undo);
    };
    addEventListener('afterprint', undo);
    setTimeout(function () { print(); setTimeout(undo, 1000); }, 30);
  }

  // ---- Full screen: zoom and move ----
  var view = document.createElement('dialog');
  view.className = 'fig-view';
  view.setAttribute('aria-labelledby', 'fig-view-title');
  view.innerHTML = '<header><h2 id="fig-view-title"></h2><span class="fig-zoom" aria-live="polite"></span></header><div class="fig-stage" tabindex="0" role="group" aria-label="Figure; drag or use arrow keys to move, plus and minus to zoom"><div class="fig-content"></div></div>';
  var head = view.querySelector('header');
  var zoomOut = button('Zoom out', 'minus', function () { zoomBy(1 / 1.25); });
  var zoomIn = button('Zoom in', 'plus', function () { zoomBy(1.25); });
  var fitBtn = button('Fit to screen', 'fit', function () { fit(); });
  var copyBtn = button('Copy', 'copy', function () { copyFigure(current); });
  var printBtn = button('Print', 'print', function () { printFigure(current); });
  var closeBtn = button('Close full screen', 'close', function () { closeView(); });
  var zoomLabel = head.querySelector('.fig-zoom');
  head.insertBefore(zoomOut, zoomLabel);
  head.appendChild(zoomIn);
  head.appendChild(fitBtn);
  head.appendChild(copyBtn);
  head.appendChild(printBtn);
  head.appendChild(closeBtn);
  var stage = view.querySelector('.fig-stage');
  var content = view.querySelector('.fig-content');
  var current = null;
  var opener = null;
  var s = 1, tx = 0, ty = 0;
  function apply() {
    content.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    zoomLabel.textContent = Math.round(s * 100) + '%';
  }
  function size() {
    return { w: content.offsetWidth, h: content.offsetHeight, W: stage.clientWidth, H: stage.clientHeight };
  }
  function fit() {
    var z = size();
    s = Math.min(z.W / z.w, z.H / z.h, 4) * 0.96;
    tx = (z.W - z.w * s) / 2;
    ty = (z.H - z.h * s) / 2;
    apply();
  }
  function zoomBy(f, cx, cy) {
    var z = size();
    if (cx === undefined) { cx = z.W / 2; cy = z.H / 2; }
    var ns = Math.max(0.1, Math.min(8, s * f));
    tx = cx - ((cx - tx) * ns) / s;
    ty = cy - ((cy - ty) * ns) / s;
    s = ns;
    apply();
  }
  function openView(fig) {
    current = fig;
    opener = document.activeElement;
    view.querySelector('h2').textContent = titleOf(fig);
    content.innerHTML = '';
    var src = fig._src();
    var clone = src.cloneNode(true);
    if (clone.tagName.toLowerCase() === 'svg') {
      var vb = src.viewBox && src.viewBox.baseVal;
      clone.removeAttribute('style');
      clone.setAttribute('width', (vb && vb.width) || src.getBoundingClientRect().width);
      clone.setAttribute('height', (vb && vb.height) || src.getBoundingClientRect().height);
    }
    content.appendChild(clone);
    if (view.showModal) view.showModal();
    else view.setAttribute('open', '');
    if (view.requestFullscreen && !narrow) view.requestFullscreen().catch(function () {});
    requestAnimationFrame(function () { fit(); stage.focus(); });
  }
  function closeView() {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    if (view.close) view.close();
    else view.removeAttribute('open');
  }
  view.addEventListener('close', function () {
    content.innerHTML = '';
    if (opener && opener.focus) opener.focus();
  });
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  stage.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(1 / 1.25);
    else if (k === '0') fit();
    else if (k === 'ArrowLeft') { tx += 40; apply(); }
    else if (k === 'ArrowRight') { tx -= 40; apply(); }
    else if (k === 'ArrowUp') { ty += 40; apply(); }
    else if (k === 'ArrowDown') { ty -= 40; apply(); }
    else return;
    e.preventDefault();
  });
  var pts = {}, last = null, pinch = null;
  stage.addEventListener('pointerdown', function (e) {
    stage.setPointerCapture(e.pointerId);
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    stage.classList.add('drag');
  });
  stage.addEventListener('pointermove', function (e) {
    if (!pts[e.pointerId]) return;
    var prev = pts[e.pointerId];
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pts);
    if (ids.length === 2) {
      var a = pts[ids[0]], b = pts[ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      var r = stage.getBoundingClientRect();
      if (pinch) zoomBy(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      pinch = d;
    } else {
      tx += e.clientX - prev.x;
      ty += e.clientY - prev.y;
      apply();
    }
  });
  function up(e) {
    delete pts[e.pointerId];
    pinch = null;
    if (!Object.keys(pts).length) stage.classList.remove('drag');
  }
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  addEventListener('resize', function () { if (view.open) fit(); });

  // ---- Wrap each figure ----
  function wrap(el, kind) {
    if (el.closest('.fig') || el.closest('.fig-view')) return null;
    var fig = document.createElement('figure');
    fig.className = 'fig';
    fig.dataset.kind = kind;
    var host = el.parentElement && /\b(tscroll|tablewrap|diagram)\b/.test(el.parentElement.className) && el.parentElement.children.length === 1 ? el.parentElement : el;
    host.parentNode.insertBefore(fig, host);
    var bar = document.createElement('div');
    bar.className = 'fig-bar';
    bar.setAttribute('role', 'toolbar');
    var name = kind === 'diagram' ? 'Diagram' : 'Table';
    bar.setAttribute('aria-label', name + ' controls');
    bar.appendChild(button('Full screen', 'full', function () { openView(fig); }));
    bar.appendChild(button('Copy ' + name.toLowerCase(), 'copy', function () { copyFigure(fig); }));
    bar.appendChild(button('Print ' + name.toLowerCase(), 'print', function () { printFigure(fig); }));
    fig.appendChild(bar);
    fig.appendChild(host);
    if (host !== el) host.classList.add('fig-host');
    fig._src = kind === 'table' ? function () { return fig.querySelector('table'); } : function () { return el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg'); };
    return fig;
  }

  // Tables: labelled for restacking, with roles kept explicit so a restacked table is still read as a table.
  function prepareTable(fig) {
    var t = fig.querySelector('table');
    var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.innerText.replace(/\s+/g, ' ').trim(); });
    t.setAttribute('role', 'table');
    Array.prototype.forEach.call(t.querySelectorAll('thead, tbody, tfoot'), function (g) { g.setAttribute('role', 'rowgroup'); });
    Array.prototype.forEach.call(t.rows, function (r) {
      r.setAttribute('role', 'row');
      Array.prototype.forEach.call(r.cells, function (c, i) {
        if (c.tagName === 'TH') c.setAttribute('role', c.closest('thead') ? 'columnheader' : 'rowheader');
        else {
          c.setAttribute('role', 'cell');
          if (heads[i]) c.setAttribute('data-label', heads[i]);
        }
      });
    });
  }
  var tableFigs = [];
  function restack() {
    tableFigs.forEach(function (fig) {
      fig.classList.remove('stack');
      var t = fig.querySelector('table');
      if (t.scrollWidth > fig.clientWidth + 1) fig.classList.add('stack');
    });
  }

  function start() {
  // Phone menu: the side list folds behind a Menu button, showing only the page you are on; open, it wraps.
  // Without this script the list simply wraps, so it never scrolls sideways either way.
  (function () {
    var side = document.querySelector('nav.side');
    if (!side || side.querySelector('.side-toggle')) return;
    side.id = side.id || 'side-menu';
    var t = document.createElement('button');
    t.type = 'button';
    t.className = 'side-toggle';
    t.setAttribute('aria-controls', side.id);
    t.setAttribute('aria-expanded', 'false');
    t.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span>Menu</span>';
    side.appendChild(t);
    side.classList.add('closed');
    t.addEventListener('click', function () {
      var open = side.classList.toggle('closed') === false;
      t.setAttribute('aria-expanded', String(open));
      t.querySelector('span').textContent = open ? 'Close menu' : 'Menu';
    });
  })();
    document.body.appendChild(live);
    document.body.appendChild(view);
    var scope = document.querySelector('main') || document.body;
    Array.prototype.forEach.call(scope.querySelectorAll('table'), function (t) {
      if (t.closest('nav') || t.rows.length < 2) return;
      var fig = wrap(t, 'table');
      if (fig) {
        prepareTable(fig);
        tableFigs.push(fig);
      }
    });
    restack();
    var resizeTimer;
    addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(restack, 120); });
    // A table in a view that is hidden at load is measured again when it is shown.
    if (window.ResizeObserver) { var ro = new ResizeObserver(function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(restack, 60); }); tableFigs.forEach(function (f) { ro.observe(f); }); }

    // Diagrams drawn as SVG in the page itself.
    Array.prototype.forEach.call(scope.querySelectorAll('.diagram > svg'), function (svg) {
      var fig = wrap(svg, 'diagram');
      if (fig) svg.addEventListener('click', function () { openView(fig); });
    });

    if (!window.mermaid) return;
    var diagrams = scope.querySelectorAll('pre.mermaid');
    Array.prototype.forEach.call(diagrams, function (m) {
      if (narrow) m.textContent = m.textContent.replace(/^(\s*(?:flowchart|graph))\s+LR\b/, '$1 TB').replace(/\bdirection\s+LR\b/g, 'direction TB').replace(/^(\s*subgraph[^\n]*\n)(?!\s*direction)/gm, '$1direction TB\n');
      var fig = wrap(m, 'diagram');
      if (fig) m.addEventListener('click', function () { openView(fig); });
    });
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      // Labels drawn as SVG text, so a diagram can be copied as an image.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: dark
        ? { fontFamily: 'Atkinson Hyperlegible, system-ui, sans-serif', fontSize: '15px', background: '#111e25', primaryColor: '#13303a', primaryBorderColor: '#5fd0e6', primaryTextColor: '#e3edf2', secondaryColor: '#1d2a40', tertiaryColor: '#111e25', lineColor: '#97abb6', textColor: '#e3edf2', clusterBkg: '#0e1a20', clusterBorder: '#22343e', edgeLabelBackground: '#111e25', noteBkgColor: '#173842', noteTextColor: '#e3edf2' }
        : { fontFamily: 'Atkinson Hyperlegible, system-ui, sans-serif', fontSize: '15px', background: '#ffffff', primaryColor: '#e8f4f7', primaryBorderColor: '#0b6680', primaryTextColor: '#12202a', secondaryColor: '#eeedfd', tertiaryColor: '#ffffff', lineColor: '#53636f', textColor: '#12202a', clusterBkg: '#f6f9fa', clusterBorder: '#c8d6de', edgeLabelBackground: '#ffffff', noteBkgColor: '#fff6e0', noteTextColor: '#12202a' },
    });
    mermaid.run({ nodes: diagrams }).catch(function (e) { console.error('diagram', e && (e.message || e.str)); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
