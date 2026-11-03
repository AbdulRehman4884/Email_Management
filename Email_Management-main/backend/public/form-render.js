(function () {
  var d = document, w = window;
  var cfg = w.__MF_CFG || {};
  var params = new URLSearchParams(location.search);
  var embed = params.get('embed') === '1';

  function el(tag, attrs, text) {
    var e = d.createElement(tag);
    for (var k in attrs || {}) {
      if (attrs[k] === false || attrs[k] == null) continue;
      if (k === 'className') e.className = attrs[k];
      else e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    if (text != null) e.textContent = text;
    return e;
  }

  function postHeight() {
    if (w.parent === w) return;
    w.parent.postMessage({ mfForm: cfg.key || 'preview', h: Math.ceil(d.documentElement.scrollHeight) }, '*');
  }

  var captchaLoaded = false;
  function loadCaptcha(c) {
    if (captchaLoaded || !c) return;
    captchaLoaded = true;
    var s = el('script', {
      src: c.provider === 'turnstile' ? 'https://challenges.cloudflare.com/turnstile/v0/api.js' : 'https://www.google.com/recaptcha/api.js',
      async: true,
      defer: true
    });
    d.head.appendChild(s);
  }

  function captchaToken(form, c) {
    if (!c) return '';
    if (c.provider === 'turnstile') {
      var t = form.querySelector('[name="cf-turnstile-response"]');
      return t ? t.value : '';
    }
    return w.grecaptcha && w.grecaptcha.getResponse ? w.grecaptcha.getResponse() : '';
  }

  var INPUT = {
    email: { type: 'email', autocomplete: 'email' },
    name: { type: 'text', autocomplete: 'name' },
    company: { type: 'text', autocomplete: 'organization' },
    phone: { type: 'tel', autocomplete: 'tel' },
    text: { type: 'text' },
    number: { type: 'number', step: 'any' }
  };

  function render(root, f) {
    var ds = f.design || {};
    root.innerHTML = '';
    root.style.setProperty('--mf-bg', ds.backgroundColor || '#ffffff');
    root.style.setProperty('--mf-text', ds.textColor || '#111827');
    root.style.setProperty('--mf-btn', ds.buttonColor || '#4f46e5');
    root.style.setProperty('--mf-btn-text', ds.buttonTextColor || '#ffffff');
    root.style.setProperty('--mf-radius', ds.rounded === false ? '0px' : '10px');

    var box = el('div', { className: 'mf-box' });
    root.appendChild(box);
    if (f.title) box.appendChild(el('h1', { className: 'mf-title' }, f.title));
    if (f.description) box.appendChild(el('p', { className: 'mf-desc' }, f.description));
    if (f.closed) {
      box.appendChild(el('p', { className: 'mf-closed' }, 'This form is closed'));
      postHeight();
      return;
    }

    var form = el('form', { novalidate: true });
    var errs = {};
    (f.fields || []).forEach(function (fd) {
      var id = 'mf-' + fd.id;
      var row = el('div', { className: 'mf-row' });
      var label = el('label', { for: id }, fd.label);
      if (fd.required) label.appendChild(el('span', { className: 'mf-req' }, ' *'));
      row.appendChild(label);
      var input;
      if (fd.type === 'message') input = el('textarea', { id: id, name: fd.id, rows: '4' });
      else if (fd.type === 'dropdown') {
        input = el('select', { id: id, name: fd.id });
        input.appendChild(el('option', { value: '' }, fd.placeholder || 'Choose…'));
        (fd.options || []).forEach(function (o) {
          input.appendChild(el('option', { value: o }, o));
        });
      } else input = el('input', Object.assign({ id: id, name: fd.id }, INPUT[fd.type] || INPUT.text));
      if (fd.placeholder && fd.type !== 'dropdown') input.setAttribute('placeholder', fd.placeholder);
      if (fd.required) input.setAttribute('aria-required', 'true');
      row.appendChild(input);
      errs[fd.id] = el('div', { className: 'mf-err', role: 'alert' });
      row.appendChild(errs[fd.id]);
      form.appendChild(row);
    });

    var hp = el('div', { className: 'mf-hp', 'aria-hidden': 'true' });
    hp.appendChild(el('input', { name: '_hp', tabindex: '-1', autocomplete: 'off' }));
    form.appendChild(hp);

    var consent = null;
    if (f.consentEnabled) {
      var cl = el('label', { className: 'mf-consent' });
      consent = el('input', { type: 'checkbox', name: 'consent' });
      cl.appendChild(consent);
      cl.appendChild(el('span', null, ' ' + (f.consentText || '')));
      form.appendChild(cl);
      errs.consent = el('div', { className: 'mf-err', role: 'alert' });
      form.appendChild(errs.consent);
    }

    if (f.captcha && !cfg.preview) {
      form.appendChild(el('div', { className: f.captcha.provider === 'turnstile' ? 'cf-turnstile' : 'g-recaptcha', 'data-sitekey': f.captcha.siteKey }));
      loadCaptcha(f.captcha);
    }

    var btn = el('button', { type: 'submit', className: 'mf-btn' }, ds.buttonText || 'Submit');
    form.appendChild(btn);
    var status = el('p', { className: 'mf-status', role: 'status' });
    form.appendChild(status);
    box.appendChild(form);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      for (var k in errs) errs[k].textContent = '';
      status.textContent = '';
      if (cfg.preview) {
        status.textContent = 'Preview: submissions are off here.';
        postHeight();
        return;
      }
      var values = {};
      (f.fields || []).forEach(function (fd) {
        values[fd.id] = form.elements[fd.id].value;
      });
      btn.disabled = true;
      fetch(cfg.submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: values,
          consent: consent ? consent.checked : undefined,
          _hp: form.elements._hp.value,
          captchaToken: captchaToken(form, f.captcha),
          v: params.get('v') || undefined,
          page: params.get('page') || location.href
        })
      })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
        })
        .then(function (r) {
          btn.disabled = false;
          if (r.status === 200 && r.body.ok) {
            box.innerHTML = '';
            box.appendChild(el('p', { className: 'mf-done' }, r.body.message));
          } else if (r.body.errors) {
            for (var k in r.body.errors) if (errs[k]) errs[k].textContent = r.body.errors[k];
            status.textContent = r.body.error || 'Please check the form.';
          } else {
            status.textContent = r.body.error || 'Something went wrong. Please try again.';
          }
          postHeight();
        })
        .catch(function () {
          btn.disabled = false;
          status.textContent = 'Could not send. Check your connection and try again.';
          postHeight();
        });
    });
    postHeight();
  }

  var root = d.getElementById('mf-root');
  if (embed) d.body.className += ' mf-embed';
  if (cfg.preview) {
    w.addEventListener('message', function (e) {
      if ((cfg.allowedOrigins || []).indexOf(e.origin) < 0 || !e.data || !e.data.mfPreview) return;
      render(root, e.data.mfPreview);
    });
    if (w.parent !== w) w.parent.postMessage({ mfPreviewReady: true }, '*');
  } else {
    render(root, cfg.form || {});
  }
  if (w.ResizeObserver) new ResizeObserver(postHeight).observe(d.body);
})();
