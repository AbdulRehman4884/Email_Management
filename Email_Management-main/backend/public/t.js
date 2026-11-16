(function () {
  var d = document, w = window, n = navigator, s = d.currentScript;
  if (!s || w.__mfTracked) return;
  w.__mfTracked = 1;
  var site = s.getAttribute('data-site');
  var api = s.src.replace(/\/t\.js([?#].*)?$/, '');
  if (!site || n.doNotTrack == '1' || w.doNotTrack == '1' || n.webdriver) return;

  function get(k) {
    var m = d.cookie.match('(?:^|; )' + k + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }
  function set(k, v) {
    d.cookie = k + '=' + encodeURIComponent(v) + '; max-age=7776000; path=/; SameSite=Lax' + (location.protocol == 'https:' ? '; Secure' : '');
  }
  function rid() {
    var a = new Uint8Array(16), h = '';
    (w.crypto || w.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) h += (a[i] + 256).toString(16).slice(1);
    return h;
  }

  var vid = get('_mfv') || rid();
  var code = '', fresh = 0, ref = d.referrer, last = '';
  try {
    var u = new URL(location.href), mf = u.searchParams.get('mf');
    if (mf) {
      code = mf;
      fresh = 1;
      u.searchParams.delete('mf');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    }
  } catch (e) {}
  if (!code) code = get('_mfc');

  function send() {
    if (location.pathname == last) return;
    last = location.pathname;
    var ok = get('_mfok') == '1' || s.getAttribute('data-consent') == 'granted';
    var body = JSON.stringify({ s: site, v: vid, u: location.href, t: d.title, r: ref, m: code, f: fresh, c: ok ? 1 : 0 });
    var c = code, f = fresh;
    fresh = 0;
    ref = '';
    fetch(api + '/api/public/track', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.s) {
          if (f) fresh = 1;
          last = '';
          return;
        }
        set('_mfv', vid);
        if (c && j.m) set('_mfc', c);
      })
      .catch(function () {});
  }

  w.mailflow = {
    consent: function () {
      set('_mfok', '1');
      last = '';
      send();
    }
  };

  var push = history.pushState;
  history.pushState = function () {
    push.apply(this, arguments);
    send();
  };
  w.addEventListener('popstate', send);
  send();
})();
