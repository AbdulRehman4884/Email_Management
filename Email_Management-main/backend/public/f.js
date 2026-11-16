(function () {
  var d = document, w = window, s = d.currentScript;
  if (!s) return;
  var key = s.getAttribute('data-form');
  if (!/^FM_[A-Za-z0-9_-]+$/.test(key || '')) return;
  var base = s.src.replace(/\/f\.js([?#].*)?$/, '');
  var origin = new URL(base, location.href).origin;
  var frames = [];

  function visitor() {
    var m = d.cookie.match('(?:^|; )_mfv=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }
  function frame() {
    var f = d.createElement('iframe');
    f.src = base + '/f/' + key + '?embed=1&v=' + encodeURIComponent(visitor()) + '&page=' + encodeURIComponent(location.href);
    f.title = 'Form';
    f.style.cssText = 'width:100%;border:0;height:380px;display:block;background:transparent;color-scheme:normal';
    frames.push(f);
    return f;
  }

  w.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.mfForm !== key) return;
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === e.source) frames[i].style.height = e.data.h + 'px';
  });

  if (s.getAttribute('data-mode') !== 'popup') {
    var box = d.createElement('div');
    box.appendChild(frame());
    s.parentNode.insertBefore(box, s.nextSibling);
    return;
  }

  var overlay = null;
  function close() {
    if (overlay) overlay.style.display = 'none';
    try { sessionStorage.setItem('mf_closed_' + key, '1'); } catch (e) {}
  }
  function open() {
    if (!overlay) {
      overlay = d.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;padding:16px';
      var panel = d.createElement('div');
      panel.style.cssText = 'position:relative;width:100%;max-width:480px;max-height:90vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.3)';
      var x = d.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.textContent = '×';
      x.style.cssText = 'position:absolute;top:6px;right:10px;border:0;background:none;font-size:26px;line-height:1;cursor:pointer;color:#6b7280;z-index:1';
      x.onclick = close;
      overlay.onclick = function (e) { if (e.target === overlay) close(); };
      panel.appendChild(x);
      panel.appendChild(frame());
      overlay.appendChild(panel);
      d.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
  }

  d.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-mailflow-open]') : null;
    if (t && t.getAttribute('data-mailflow-open') === key) {
      e.preventDefault();
      open();
    }
  });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  var delay = s.getAttribute('data-delay');
  var seen = false;
  try { seen = sessionStorage.getItem('mf_closed_' + key) === '1'; } catch (e) {}
  if (delay !== null && delay !== '' && !seen) setTimeout(open, Math.max(0, Number(delay) || 0) * 1000);
})();
