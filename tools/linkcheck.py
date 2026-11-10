"""
Follow every link on every page of zthr.ai as Firebase Hosting serves it: trailing slashes stripped, clean URLs,
and the forwarding rules in firebase.json. A link that finds no page (Firebase answers 404), loops, or forwards to a
path the app does not serve fails the deploy. So does an inline script the content security policy would block,
and a security.txt that is missing or within 30 days of expiring.

    python3 tools/linkcheck.py .
"""
import base64, datetime, hashlib, json, os, re, sys
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

ROOT = sys.argv[1]  # the site repo
PUB = os.path.join(ROOT, 'docs')
cfg = json.load(open(os.path.join(ROOT, 'firebase.json')))['hosting']
# What the app at Cloud Run serves: its own router's table, published with the reference pages
# (docs/reference/app-routes.json), so a link into the app is checked against the routes that exist.
def _app_routes():
    t = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'reference', 'app-routes.json')))
    pats = [re.escape(t['base']) + re.sub(r'\\:[A-Za-z_]+|:[A-Za-z_]+', '[^/]+', re.escape(r).replace('\\:', ':')).rstrip('/') + '/?' for r in t['routes']]
    pats += [re.escape(p) + '(/.*)?' for p in t.get('prefixes', [])]
    return re.compile('^(' + '|'.join(pats) + ')$')
APP_ROUTES = _app_routes()

def file_for(path):
    """What Firebase serves for a clean path, or None (not found)."""
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
            if r[0] == 'home' and (u.path or '/') not in ('/', ''): problems.append((rel, h, 'not found (404): ' + u.path))
            elif r[0] == 'loop': problems.append((rel, h, 'redirect loop'))
            elif r[0] == 'external':
                ep = urlparse(r[1]).path
                if not APP_ROUTES.match(ep): problems.append((rel, h, 'forwarded to an app path the app does not serve: ' + ep))
# Every inline script must be allowed by hash in the content security policy, or browsers will refuse to run it.
csp = next((h['value'] for blk in cfg.get('headers', []) for h in blk['headers'] if h['key'] == 'Content-Security-Policy'), '')
scripts = 0
for dp, _, fs in os.walk(PUB):
    for fn in fs:
        if not fn.endswith('.html'): continue
        f = os.path.join(dp, fn)
        for m in re.finditer(r'<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>', open(f, encoding='utf8').read(), re.S):
            if 'json' in m.group(1): continue
            scripts += 1
            h = "'sha256-" + base64.b64encode(hashlib.sha256(m.group(2).encode()).digest()).decode() + "'"
            if h not in csp: problems.append(('/' + os.path.relpath(f, PUB), h, 'inline script not allowed by the content security policy'))
# security.txt (RFC 9116): present, served at /.well-known/security.txt, and not about to expire.
st = os.path.join(PUB, 'security.txt')
if not os.path.isfile(st) or not any(r.get('source') == '/.well-known/security.txt' for r in cfg.get('rewrites', [])):
    problems.append(('/security.txt', '', 'missing, or not served at /.well-known/security.txt'))
else:
    exp = re.search(r'^Expires:\s*(\S+)', open(st).read(), re.M)
    left = (datetime.datetime.fromisoformat(exp.group(1).replace('Z', '+00:00')) - datetime.datetime.now(datetime.timezone.utc)).days if exp else -1
    if left < 30: problems.append(('/security.txt', '', f'expires in {left} days'))
print(f'{pages} pages, {checked} links checked, {scripts} inline scripts allowed by hash, {len(problems)} problems')
seen = set()
for pg, h, why in problems:
    if (h, why) in seen: continue
    seen.add((h, why)); print(f'  {pg}: {h} -> {why}')
sys.exit(1 if problems else 0)
