"""
Follow every link on every page of zthr.ai as Firebase Hosting serves it: trailing slashes stripped, clean URLs,
the forwarding rules in firebase.json, and the catch-all that sends anything not found to the home page. A link
that would land on the home page by accident, loop, or forward to a path the app does not serve fails the deploy.

    python3 tools/linkcheck.py .
"""
import json, os, re, sys
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

ROOT = sys.argv[1]  # the site repo
PUB = os.path.join(ROOT, 'docs')
cfg = json.load(open(os.path.join(ROOT, 'firebase.json')))['hosting']
# What the app at Cloud Run serves under /studentadvocate and /twins.
APP_ROUTES = re.compile(r'^/studentadvocate(/(s/[a-z]+(/[a-z-]+)?|admin(/[a-z-]*)?|text|version|api/.*|_ui/.*)?)?/?$|^/twins(/.*)?$')

def file_for(path):
    """What Firebase serves for a clean path, or None (the catch-all: the home page)."""
    p = path.rstrip('/') or '/'
    cands = [p] if os.path.splitext(p)[1] and not p.endswith('.html') else []
    cands += [p + '.html', p.rstrip('/') + '/index.html'] if p != '/' else ['/index.html']
    for c in cands:
        f = os.path.join(PUB, c.lstrip('/'))
        if os.path.isfile(f): return f
    return None

def serve(path, hops=0):
    """Final outcome of requesting path: ('file', f, final_path) | ('external', url) | ('home', path) | ('loop', path)."""
    if hops > 8: return ('loop', path)
    if path != '/' and path.endswith('/'): return serve(path.rstrip('/'), hops + 1)  # trailingSlash: false
    if path.endswith('.html'):  # cleanUrls
        q = path[:-5]
        q = q[:-6] if q.endswith('/index') else q
        return serve(q or '/', hops + 1)
    for r in cfg.get('redirects', []):
        if 'regex' in r:
            m = re.match(r['regex'], path)
            if m:
                dest = r['destination']
                for k, v in m.groupdict().items(): dest = dest.replace(':' + k, v)
                return ('external', dest) if dest.startswith('http') else serve(dest, hops + 1)
        elif r['source'] == path:
            d = r['destination']
            return ('external', d) if d.startswith('http') else serve(d, hops + 1)
    f = file_for(path)
    return ('file', f, path) if f else ('home', path)

class Links(HTMLParser):
    def __init__(self): super().__init__(); self.base = None; self.hrefs = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'base' and a.get('href'): self.base = a['href']
        if tag == 'a' and a.get('href'): self.hrefs.append(a['href'])

problems, checked, pages = [], 0, 0
for dp, _, fs in os.walk(PUB):
    for fn in fs:
        if not fn.endswith('.html'): continue
        f = os.path.join(dp, fn)
        rel = '/' + os.path.relpath(f, PUB)
        out = serve(rel)
        if out[0] != "file" or os.path.realpath(out[1]) != os.path.realpath(f): continue  # shadowed: never served
        page_url = 'https://zthr.ai' + out[2]  # the address a browser actually ends up at
        pages += 1
        p = Links(); p.feed(open(f, encoding='utf8').read())
        base = urljoin(page_url, p.base) if p.base else page_url
        for h in p.hrefs:
            if h.startswith(('mailto:', 'tel:', 'javascript:')): continue
            u = urlparse(urljoin(base, h))
            if u.netloc == 'advocate-fsy7whk33q-uc.a.run.app':
                if not APP_ROUTES.match(u.path): problems.append((rel, h, 'app path the app does not serve: ' + u.path))
                checked += 1; continue
            if u.netloc != 'zthr.ai': continue
            checked += 1
            r = serve(u.path or '/')
            if r[0] == 'home' and (u.path or '/') not in ('/', ''): problems.append((rel, h, 'lands on the home page (not found): ' + u.path))
            elif r[0] == 'loop': problems.append((rel, h, 'redirect loop'))
            elif r[0] == 'external':
                ep = urlparse(r[1]).path
                if not APP_ROUTES.match(ep): problems.append((rel, h, 'forwarded to an app path the app does not serve: ' + ep))
print(f'{pages} pages, {checked} links checked, {len(problems)} problems')
seen = set()
for pg, h, why in problems:
    if (h, why) in seen: continue
    seen.add((h, why)); print(f'  {pg}: {h} -> {why}')
sys.exit(1 if problems else 0)
