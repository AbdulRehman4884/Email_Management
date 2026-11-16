# nginx snippet: test checklist

For `deploy/nginx_mailflow_snippet.conf`. Run these on the server **where the snippet was applied** (staging first),
after `sudo nginx -t && sudo systemctl reload nginx`. Set the base URL once:

```bash
H=https://STAGING-HOST          # the server you applied the snippet to
JS=$(curl -s $H/ | grep -o 'assets/index-[^"]*\.js' | head -1); echo $JS
```

## 0. Config

| Check | Command | Expect |
|---|---|---|
| Syntax | `sudo nginx -t` | `syntax is ok` / `test is successful` |
| Brotli module present? | `nginx -V 2>&1 \| grep -o brotli` | output only if available; otherwise leave the brotli lines commented |

## N-01 compression

| Check | Command | Expect |
|---|---|---|
| Main JS gzipped | `curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' $H/$JS \| grep -i -E 'content-encoding\|vary'` | `Content-Encoding: gzip`, `Vary: Accept-Encoding` |
| Size on the wire | `curl -s -H 'Accept-Encoding: gzip' $H/$JS \| wc -c` | ~110 KB (raw file ~356 KB) |
| HTML gzipped | `curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' $H/ \| grep -i content-encoding` | `gzip` |
| API JSON gzipped | `curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' $H/api/plans \| grep -i content-encoding` | `gzip` |
| Brotli (only if enabled) | `curl -s -o /dev/null -D - -H 'Accept-Encoding: br' $H/$JS \| grep -i content-encoding` | `br` |

## N-03 caching

| Check | Command | Expect |
|---|---|---|
| Hashed asset | `curl -sI $H/$JS \| grep -i cache-control` | `public, max-age=31536000, immutable` |
| index.html | `curl -sI $H/ \| grep -i cache-control` | `no-cache` |
| SPA route | `curl -sI $H/campaigns \| grep -i cache-control` | `no-cache` |
| API not touched | `curl -sI $H/api/health \| grep -ic cache-control` | `0` (or only Express's own value, never `immutable`) |

## F-14 robots / sitemap / 404

| Check | Command | Expect |
|---|---|---|
| robots.txt | `curl -si $H/robots.txt \| head -20` | `200`, `Content-Type: text/plain`, `Disallow: /api/` ... (not HTML) |
| sitemap.xml | `curl -s -o /dev/null -w '%{http_code}\n' $H/sitemap.xml` | `404` |
| Unknown path | `curl -s -o /dev/null -w '%{http_code}\n' $H/no-such-page` | `404` (body is the app's "Page not found") |
| Probe paths | `for p in /wp-login.php /.env /admin /campaigns/12/foo; do curl -s -o /dev/null -w "%{http_code} $p\n" $H$p; done` | all `404` |
| Missing asset | `curl -si $H/assets/does-not-exist.js \| head -1; curl -s $H/assets/does-not-exist.js \| grep -c '<div id="root">'` | `404`, and `0` (not index.html) |
| SPA routes still work | `for p in / /login /packages /checkout/success /forgot-password /reset-password /help /campaigns /campaigns/create /campaigns/12 /campaigns/12/edit /follow-ups /follow-ups/schedule /analytics /inbox /crm /crm/pipelines /crm/leads /crm/forms /crm/forms/1 /agent /settings /admin/users; do curl -s -o /dev/null -w "%{http_code} $p\n" $H$p; done` | all `200` |
| Query strings | `curl -s -o /dev/null -w '%{http_code}\n' "$H/checkout/success?session_id=cs_test_x"` | `200` |
| Unknown API route | `curl -s -w ' %{http_code}\n' $H/api/does-not-exist` | JSON `{"error":...}` with `401` (logged out) or `404`, not HTML |

## N-05 / N-06 headers

| Check | Command | Expect |
|---|---|---|
| App HTML headers | `curl -sI $H/ \| grep -i -E 'x-content-type\|referrer-policy\|x-frame\|content-security\|strict-transport'` | `nosniff`, `strict-origin-when-cross-origin`, `DENY`, `frame-ancestors 'none'`, HSTS |
| No duplicates on API | `curl -sI $H/api/health \| grep -ic x-frame-options` | `1` (sent once, by Express) |
| No nginx version | `curl -sI $H/ \| grep -i '^server'` | `Server: nginx` (no `/1.x.x`) |
| No version on error page | `curl -s $H/sitemap.xml \| grep -io 'nginx/[0-9.]*'` | no output |
| No X-Powered-By | `curl -sI $H/api/health \| grep -ic x-powered-by` | `0` |
| Hosted form frameable | `curl -sI $H/f/<FORM_KEY> \| grep -i -E 'x-frame\|frame-ancestors'` (form key from CRM > Forms) | no output, status `200` |

## Backend paths still proxied

| Check | Command | Expect |
|---|---|---|
| Tracking script | `curl -sI $H/t.js \| grep -i -E '^HTTP\|content-type'` | `200`, `javascript` |
| Form embed script | `curl -sI $H/f.js \| grep -i -E '^HTTP\|content-type'` | `200`, `javascript` |
| Public track endpoint | `curl -s -w ' %{http_code}\n' -X POST -H 'Content-Type: text/plain' --data '{}' $H/api/public/track` | an Express answer (JSON / 2xx-4xx), not nginx's HTML 404/405 |
| Public form submit | `curl -s -w ' %{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' $H/api/public/forms/<FORM_KEY>/submit` | an Express JSON answer |
| Health | `curl -s $H/api/health` | `Health point. The server is running correctly` |

## Manual checks in the browser

1. Log in, open a deep link (e.g. `/campaigns/<id>`), press F5: the page reloads (no 404).
2. Upload a recipient CSV larger than 1 MB: no `413 Request Entity Too Large` (`client_max_body_size 25m`).
3. A page with an embedded MailFlow form on another site still shows the form (iframe not blocked).
4. Deploy a new web build and reload the app once: the new `assets/index-*.js` is loaded (index.html is not cached).
5. Login throttle still per visitor: 5 wrong passwords from one machine give 429, a second machine can still log in
   (checks that `X-Forwarded-For` is the real client, see the comment in the snippet).
