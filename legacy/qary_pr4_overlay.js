/* ============================================================================
   QARY OVERLAY v3 — implementación completa del brief PR4
   ============================================================================
   Contiene, en este orden:
   A. Helpers + estilos
   B. Compartir genérico (SMS / WhatsApp / Correo / Llamada / Copiar)
   C. Transportes unificados (8 tipos canon) + chip mapa + estados visuales
   D. Buscadores (Inicio mic, Explorar input + mic, ámbito y redirección)
   E. Pantallas dinámicas inyectadas:
        s-viajes        — historial de viajes con filtros
        s-referrals     — referidos en tiempo real (canal/fecha/estado)
        s-feed          — Reciente Ver todo (excepto pagos → Historial)
        s-transport-all — 8 tipos de transporte (Inicio→Ver todo→Transporte)
   F. Perfil:
        - Stats Viajes/Soles/Referidos clickables → pantallas dedicadas
        - Foto sincronizada en Inicio/Pagos/Perfil al cambiarla
   G. Recientes Ver todo → s-feed
   H. Notas de voz reales (MediaRecorder + playback inline) en chat
   I. Panel IA: TTS Femenino/Masculino/Neutro + API key + Backend URL
   J. Mapa real-time (Socket.IO) + filtro por canon de transporte
   K. Bridge nativo: window.QaryNative.postMessage({ type, ... })
============================================================================ */
(function () {
  'use strict';
  if (window.__qaryV3) return; window.__qaryV3 = true;
  var L_ = function () { try { console.log.apply(console, ['[QARY]'].concat([].slice.call(arguments))); } catch (e) {} };

  /* ─── A. HELPERS ─── */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function once(el, attr, fn) { if (!el || el.dataset[attr]) return; el.dataset[attr] = '1'; try { fn(el); } catch (e) { L_(attr, e); } }
  function ce(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k.indexOf('on') === 0) e[k] = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  function toast(msg) { if (typeof window.toast === 'function') return window.toast(msg); L_(msg); }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
  function nav(id) { if (typeof window.nav === 'function') window.nav(id); }
  function postNative(payload) {
    try { if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}
  }
  window.QaryNative = { postMessage: postNative };

  function ls(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsJson(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function lsJsonSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var BACKEND = ls('qary_backend_url', '');
  function setBackend(url) {
    BACKEND = (url || '').trim().replace(/\/$/, ''); lsSet('qary_backend_url', BACKEND);
  }
  window.qarySetBackend = setBackend;

  /* ─── ESTILOS ─── */
  var styleEl = ce('style', { id: 'qary-v3-style' });
  styleEl.textContent =
    /* Selección unificada de transporte */
    '.qary-tr-active{position:relative;}'+
    '.qary-tr-active::after{content:"";position:absolute;inset:-2px;border-radius:14px;'+
      'box-shadow:inset 0 0 0 2px #2B2FD9;pointer-events:none;}'+
    '.svc-btn.qary-tr-active{background:linear-gradient(135deg,rgba(43,47,217,.07),rgba(255,45,120,.04));}'+
    '.svc-big.qary-tr-active{background:rgba(43,47,217,.06);}'+
    '.rt.qary-tr-active{background:rgba(43,47,217,.06);}'+
    '.qary-tr-row{display:flex;gap:10px;padding:6px 18px 12px;overflow-x:auto;scrollbar-width:none;}'+
    '.qary-tr-row::-webkit-scrollbar{display:none}'+
    '.qary-tr-card{flex:0 0 auto;min-width:96px;background:#fff;border:1.5px solid var(--border);'+
      'border-radius:14px;padding:12px 8px;text-align:center;cursor:pointer;transition:transform .12s,border-color .12s;}'+
    '.qary-tr-card:active{transform:scale(.96)}'+
    '.qary-tr-card.qary-tr-active{border-color:#2B2FD9;background:rgba(43,47,217,.04);}'+
    '.qary-tr-card .ico{font-size:24px;margin-bottom:4px;}'+
    '.qary-tr-card .nm{font-size:11.5px;font-weight:700;color:var(--navy);}'+
    '.qary-tr-card .pr{font-size:10px;color:var(--muted);margin-top:2px;}'+

    /* Chip mapa */
    '#qary-tr-chip{position:absolute;top:14px;left:50%;transform:translateX(-50%);'+
      'background:rgba(13,11,46,.86);color:#fff;border-radius:99px;padding:6px 14px;'+
      'font:600 12px/1 Outfit,sans-serif;display:none;z-index:520;backdrop-filter:blur(8px);'+
      'box-shadow:0 4px 14px rgba(0,0,0,.25);}'+
    '#qary-tr-chip.on{display:flex;align-items:center;gap:6px;}'+

    /* Mic embebido (Explorar) */
    '.qary-mic-emb{flex-shrink:0;width:30px;height:30px;border-radius:50%;border:none;'+
      'background:rgba(43,47,217,.12);color:#2B2FD9;font-size:14px;cursor:pointer;'+
      'display:inline-flex;align-items:center;justify-content:center;transition:transform .12s;}'+
    '.qary-mic-emb:active{transform:scale(.85)}'+
    '.qary-mic-emb.on,.qary-mic-active.on{background:#FF2D78;color:#fff;animation:qaryMicPulse 1s ease-in-out infinite;}'+
    '@keyframes qaryMicPulse{50%{box-shadow:0 0 0 6px rgba(255,45,120,.22)}}'+

    /* Mic emoji existente (Home) */
    '#s-home .search-wrap span.qary-mic-active{color:#fff!important;cursor:pointer;'+
      'font-size:18px!important;background:rgba(255,255,255,.16);'+
      'border-radius:50%;width:30px;height:30px;display:inline-flex;align-items:center;'+
      'justify-content:center;transition:background .12s;}'+

    /* Driver markers */
    '.qary-drv-mk{width:36px;height:36px;display:flex;align-items:center;justify-content:center;'+
      'border-radius:50%;background:#fff;border:2px solid #2B2FD9;font-size:18px;'+
      'box-shadow:0 4px 12px rgba(0,0,0,.18);transition:transform .8s linear;}'+

    /* Cards panel IA */
    '.qary-cfg-block{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:14px;margin:14px 0;}'+
    '.qary-cfg-block h4{font:800 13px/1 Outfit,sans-serif;color:var(--navy);text-transform:uppercase;letter-spacing:.6px;margin:0 0 10px;}'+
    '.qary-cfg-block label{display:block;font-size:11px;color:var(--muted);margin:8px 0 4px;font-weight:600;}'+
    '.qary-cfg-block input,.qary-cfg-block select{width:100%;padding:10px 12px;border:1.5px solid var(--border);'+
      'border-radius:10px;font:600 13px/1.2 Outfit,sans-serif;background:#F7F8FF;color:var(--navy);outline:none;box-sizing:border-box;}'+
    '.qary-cfg-block input:focus,.qary-cfg-block select:focus{border-color:#2B2FD9;background:#fff;}'+
    '.qary-tts-row{display:flex;gap:6px;}'+
    '.qary-tts-row button{flex:1;padding:9px 6px;border:1.5px solid var(--border);border-radius:10px;'+
      'background:#fff;color:var(--navy);cursor:pointer;font:700 12px/1.1 Outfit,sans-serif;}'+
    '.qary-tts-row button.on{background:linear-gradient(135deg,#2B2FD9,#FF2D78);color:#fff;border-color:transparent;}'+
    '.qary-cfg-block .actions{display:flex;gap:8px;margin-top:10px;}'+
    '.qary-cfg-block .actions button{flex:1;padding:10px;border-radius:10px;font:700 12.5px/1.1 Outfit,sans-serif;cursor:pointer;border:1.5px solid var(--border);}'+
    '.qary-cfg-block .actions .pri{background:linear-gradient(135deg,#2B2FD9,#FF2D78);color:#fff;border-color:transparent;}'+
    '.qary-cfg-block .actions .sec{background:#fff;color:var(--navy);}'+

    /* Compartir grid */
    '.qary-share-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;}'+
    '.qary-share-btn{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:14px 10px;'+
      'cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;font:700 12px/1.2 Outfit,sans-serif;color:var(--navy);transition:transform .12s;}'+
    '.qary-share-btn:active{transform:scale(.96)}'+
    '.qary-share-btn .ico{font-size:24px}'+

    /* Listas (viajes / referrals / feed) */
    '.qary-list{display:flex;flex-direction:column;gap:8px;padding:8px 18px 80px;}'+
    '.qary-list-item{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:12px;display:flex;align-items:center;gap:12px;}'+
    '.qary-list-item .ico{width:38px;height:38px;border-radius:10px;background:rgba(43,47,217,.08);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}'+
    '.qary-list-item .body{flex:1;min-width:0;}'+
    '.qary-list-item h5{font:800 13px/1.2 Outfit,sans-serif;color:var(--navy);margin:0 0 2px;}'+
    '.qary-list-item p{font:600 11.5px/1.3 Outfit,sans-serif;color:var(--muted);margin:0;}'+
    '.qary-list-item .meta{font:700 12px/1 Outfit,sans-serif;color:var(--navy);text-align:right;flex-shrink:0;}'+
    '.qary-badge{font:700 10px/1 Outfit,sans-serif;padding:3px 7px;border-radius:99px;display:inline-block;}'+
    '.qary-badge.ok{background:rgba(0,196,140,.12);color:#00723C}'+
    '.qary-badge.pend{background:rgba(255,176,32,.12);color:#A66B00}'+
    '.qary-badge.fail{background:rgba(255,59,48,.12);color:#A11919}'+

    /* Filtros */
    '.qary-filter-bar{display:flex;gap:6px;padding:8px 18px;overflow-x:auto;scrollbar-width:none;}'+
    '.qary-filter-bar::-webkit-scrollbar{display:none}'+
    '.qary-filter-chip{flex:0 0 auto;background:#fff;border:1.5px solid var(--border);border-radius:99px;padding:6px 12px;font:700 11.5px/1 Outfit,sans-serif;color:var(--navy);cursor:pointer;}'+
    '.qary-filter-chip.on{background:linear-gradient(135deg,#2B2FD9,#FF2D78);color:#fff;border-color:transparent;}'+

    /* Voice note bubble */
    '.qary-voice-bubble{background:#fff;border:1.5px solid var(--border);border-radius:14px;'+
      'padding:8px 10px;margin:6px 0;display:inline-flex;align-items:center;gap:8px;max-width:80%;}'+
    '.qary-voice-bubble audio{max-width:220px;}';
  document.head.appendChild(styleEl);

  /* ─── Speech Recognition ─── */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listenOnce(lang) {
    return new Promise(function (resolve, reject) {
      if (!SR) return reject(new Error('reconocimiento de voz no soportado'));
      var r = new SR();
      r.lang = lang || 'es-PE'; r.interimResults = false; r.continuous = false;
      r.onresult = function (e) { resolve(((e.results[0] || {})[0] || {}).transcript || ''); };
      r.onerror = function (e) { reject(new Error(e.error || 'error de voz')); };
      r.start();
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     B. COMPARTIR GENÉRICO
     ════════════════════════════════════════════════════════════════════════ */
  // Cualquier window.open con tel:/sms:/mailto:/wa.me/api.whatsapp.com YA está
  // enrutado por el wrapper Expo (mobile/App.tsx onShouldStartLoadWithRequest).
  // Aquí proveemos un panel uniforme con 4 canales + portapapeles.
  function openShareSheet(opts) {
    opts = opts || {};
    var title = opts.title || 'Compartir';
    var text  = opts.text  || '';
    var phone = opts.phone || '';
    var email = opts.email || '';

    var modal = $('#qary-share-modal');
    if (!modal) {
      modal = ce('div', { id: 'qary-share-modal', class: 'modal-overlay', style: 'position:fixed;' });
      modal.innerHTML =
        '<div class="modal-box">' +
          '<div class="modal-handle"></div>' +
          '<div class="modal-title" id="qary-share-title">Compartir</div>' +
          '<div class="qary-share-grid">' +
            '<div class="qary-share-btn" data-c="whatsapp"><span class="ico">💬</span>WhatsApp</div>' +
            '<div class="qary-share-btn" data-c="sms"><span class="ico">✉️</span>SMS</div>' +
            '<div class="qary-share-btn" data-c="email"><span class="ico">📧</span>Correo</div>' +
            '<div class="qary-share-btn" data-c="call"><span class="ico">📞</span>Llamar</div>' +
          '</div>' +
          '<button class="btn-sec" id="qary-share-copy">📋 Copiar al portapapeles</button>' +
          '<button onclick="QaryShare.close()" style="width:100%;background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer;padding:10px;margin-top:4px;">Cancelar</button>' +
        '</div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeShareSheet();
        var btn = e.target.closest('.qary-share-btn'); if (!btn) return;
        var c = btn.getAttribute('data-c');
        var d = window.__qaryShareData || {};
        if (c === 'whatsapp') {
          var phWa = (d.phone || '').replace(/\D/g, '');
          var u = phWa
            ? 'https://api.whatsapp.com/send?phone=' + phWa + '&text=' + encodeURIComponent(d.text || '')
            : 'https://api.whatsapp.com/send?text=' + encodeURIComponent(d.text || '');
          window.open(u, '_blank');
        } else if (c === 'sms') {
          var ph = (d.phone || '').replace(/\s/g, '');
          window.open('sms:' + ph + '?body=' + encodeURIComponent(d.text || ''), '_blank');
        } else if (c === 'email') {
          var subj = encodeURIComponent(d.title || 'QARY');
          var body = encodeURIComponent(d.text || '');
          window.open('mailto:' + (d.email || '') + '?subject=' + subj + '&body=' + body, '_blank');
        } else if (c === 'call') {
          if (!d.phone) { toast('⚠️ Sin número telefónico para llamar'); return; }
          window.open('tel:' + d.phone, '_blank');
        }
        // Si la app no se abre, el wrapper RN despachará al SO.
        // El user ve fallback de copiar abajo.
      });
      modal.querySelector('#qary-share-copy').onclick = function () {
        var d = window.__qaryShareData || {};
        var s = (d.title ? d.title + '\n' : '') + (d.text || '');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(s).then(function () { toast('📋 Copiado'); }, function () { fallbackCopy(s); });
        } else { fallbackCopy(s); }
      };
    }
    function fallbackCopy(s) {
      var ta = ce('textarea', { style: 'position:fixed;top:-9999px' });
      ta.value = s; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('📋 Copiado'); } catch (e) { toast('❌ No se pudo copiar'); }
      document.body.removeChild(ta);
    }
    window.__qaryShareData = { title: title, text: text, phone: phone, email: email };
    var t = modal.querySelector('#qary-share-title'); if (t) t.textContent = title;
    modal.classList.add('on');
  }
  function closeShareSheet() { var m = $('#qary-share-modal'); if (m) m.classList.remove('on'); }
  window.QaryShare = { open: openShareSheet, close: closeShareSheet };

  /* ════════════════════════════════════════════════════════════════════════
     C. TRANSPORTES (8 tipos canon + estados unificados)
     ════════════════════════════════════════════════════════════════════════ */
  // 8 tipos exactos del brief, en orden:
  var TR_TYPES = [
    { canon: 'Standard', emoji: '🚗', from: 8.5,  eta: '4 min', aliases: ['Ride','std'] },
    { canon: 'Confort',  emoji: '🚙', from: 14,   eta: '5 min', aliases: ['cf'] },
    { canon: 'Executive',emoji: '🚕', from: 18,   eta: '5 min', aliases: ['Exec','ex'] },
    { canon: 'Luxury',   emoji: '🛻', from: 35,   eta: '7 min', aliases: ['lx'] },
    { canon: 'XL',       emoji: '🚐', from: 15,   eta: '7 min', aliases: ['xl'] },
    { canon: 'Mudanzas', emoji: '🚛', from: 60,   eta: '12 min',aliases: ['mudanzas'] },
    { canon: 'Motos',    emoji: '🏍️', from: 5,    eta: '2 min', aliases: ['Moto','moto'] },
    { canon: 'Bike',     emoji: '🚲', from: 4,    eta: '6 min', aliases: ['bike'] },
  ];
  var TYPE_BY_KEY = {};
  TR_TYPES.forEach(function (t) {
    TYPE_BY_KEY[t.canon.toLowerCase()] = t;
    t.aliases.forEach(function (a) { TYPE_BY_KEY[a.toLowerCase()] = t; });
  });
  function metaOf(key) {
    return TYPE_BY_KEY[(key || '').toLowerCase()] || TR_TYPES[0];
  }
  function canonOf(key) { return metaOf(key).canon; }
  function isCanonMatch(rawKey, c) { return metaOf(rawKey).canon === c; }

  var TR_KEY = 'qary_transport_v1';
  var QaryTransport = {
    _l: [],
    get current() { return ls(TR_KEY, null); },
    set: function (key) {
      var c = canonOf(key); lsSet(TR_KEY, c);
      this.applyVisual(); this._l.forEach(function (f) { try { f(c); } catch (e) {} });
      try { document.dispatchEvent(new CustomEvent('qary:transport', { detail: { key: c } })); } catch (e) {}
    },
    onChange: function (f) { this._l.push(f); },
    applyVisual: function () {
      var cur = this.current;
      // Inicio: .svc-btn[data-svc-home]
      $$('.svc-btn[data-svc-home]').forEach(function (el) {
        el.classList.toggle('qary-tr-active', !!(cur && isCanonMatch(el.getAttribute('data-svc-home'), cur)));
      });
      // Pedir: .rt[data-svc-key]
      $$('.rt[data-svc-key]').forEach(function (el) {
        el.classList.toggle('qary-tr-active', !!(cur && isCanonMatch(el.getAttribute('data-svc-key'), cur)));
      });
      // svc-big con onclick="qaryHomeServiceTap('Ride')"
      $$('.svc-big[onclick*="qaryHomeServiceTap"]').forEach(function (el) {
        var m = /qaryHomeServiceTap\(['"]([^'"]+)['"]\)/.exec(el.getAttribute('onclick') || '');
        if (!m) return;
        el.classList.toggle('qary-tr-active', !!(cur && isCanonMatch(m[1], cur)));
      });
      // Cards de la pantalla "Ver todo Transporte" (s-transport-all)
      $$('.qary-tr-card[data-tr-canon]').forEach(function (el) {
        el.classList.toggle('qary-tr-active', !!(cur && el.getAttribute('data-tr-canon') === cur));
      });
      // Chip mapa
      var area = $('#map-area'); var chip = $('#qary-tr-chip');
      if (area && !chip) { chip = ce('div', { id: 'qary-tr-chip' }); area.appendChild(chip); }
      if (chip) {
        if (cur) {
          var m = metaOf(cur);
          chip.innerHTML = '<span>' + m.emoji + '</span><span>Qary ' + m.canon + '</span>';
          chip.classList.add('on');
        } else { chip.classList.remove('on'); }
      }
    },
  };
  window.QaryTransport = QaryTransport;

  // Capture clicks (capture-phase para ordenar antes de onclick legacy)
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-svc-home],[data-svc-key],.svc-big[onclick*="qaryHomeServiceTap"],.qary-tr-card[data-tr-canon]');
    if (!el) return;
    var key = el.getAttribute('data-svc-home') || el.getAttribute('data-svc-key') || el.getAttribute('data-tr-canon');
    if (!key) {
      var m = /qaryHomeServiceTap\(['"]([^'"]+)['"]\)/.exec(el.getAttribute('onclick') || '');
      key = m ? m[1] : null;
    }
    if (key) QaryTransport.set(key);
  }, true);

  /* ════════════════════════════════════════════════════════════════════════
     D. BUSCADORES
     ════════════════════════════════════════════════════════════════════════ */
  var SEARCH_ROUTES = [
    { rx: /comid|deliver|food|burguer|hambur|pizza|sushi|taco/i, screen: 'explore', filter: 'food' },
    { rx: /transport|taxi|carro|moto|viaj|llev[ao]|conduct/i,    screen: 'map' },
    { rx: /merc|tiend|super|abarrot|market/i,                    screen: 'explore', filter: 'market' },
    { rx: /paquet|env[ií]o|express|courier/i,                    screen: 'explore', filter: 'express' },
    { rx: /hist[oó]ric|recibo|comprobant|movim|saldo|recarga/i,  screen: 'historial' },
    { rx: /soport|ayud|emergenc|sos/i,                           screen: 'soporte' },
    { rx: /perfil|cuenta|configur/i,                             screen: 'profile' },
    { rx: /premium|suscrip|plan/i,                               screen: 'premium' },
    { rx: /chat|conduct|mensaj/i,                                screen: 'chat' },
    { rx: /pago|tarjet|wallet/i,                                 screen: 'payment' },
    { rx: /viaje|hist.*viaj/i,                                   screen: 'viajes' },
    { rx: /referido/i,                                           screen: 'referrals' },
    { rx: /reciente|feed|actividad/i,                            screen: 'feed' },
  ];

  function exploreFilter(term) {
    var t = (term || '').toLowerCase().trim();
    var any = false;
    $$('#s-explore .prod-card').forEach(function (card) {
      if (!t) { card.style.display = ''; any = true; return; }
      var name = (card.querySelector('.prod-name') || {}).textContent || '';
      var shop = (card.querySelector('.prod-shop') || {}).textContent || '';
      var match = (name + ' ' + shop).toLowerCase().indexOf(t) !== -1;
      card.style.display = match ? '' : 'none';
      if (match) any = true;
    });
    var existing = $('#qary-explore-empty');
    if (!any && t) {
      if (!existing) {
        existing = ce('div', { id: 'qary-explore-empty', style: 'text-align:center;padding:32px 16px;color:var(--muted);font-size:13px;' }, '🔎 No se encontró elemento descrito');
        var scroll = $('#explore-scroll'); if (scroll) scroll.appendChild(existing);
      }
    } else if (existing) existing.remove();
  }
  window.qaryExploreFilter = exploreFilter;

  function routeBySearch(text, scope) {
    var clean = (text || '').trim();
    if (!clean) return false;
    var hit = null;
    for (var i = 0; i < SEARCH_ROUTES.length; i++) {
      if (SEARCH_ROUTES[i].rx.test(clean.toLowerCase())) { hit = SEARCH_ROUTES[i]; break; }
    }
    if (scope === 'explore') {
      exploreFilter(clean);
      if (hit && hit.screen === 'explore' && hit.filter) {
        var chip = $('.filter-chip[onclick*="\'' + hit.filter + '\'"]');
        if (chip) chip.click();
      }
      // Si no hay hit dentro de explore, mostramos mensaje no encontrado.
      return true;
    }
    if (!hit) { toast('🔎 No se encontró elemento descrito'); return false; }
    nav(hit.screen);
    if (hit.screen === 'explore') {
      setTimeout(function () {
        var inp = $('#explore-search'); if (inp) inp.value = clean;
        if (hit.filter) {
          var chip = $('.filter-chip[onclick*="\'' + hit.filter + '\'"]');
          if (chip) chip.click();
        }
        exploreFilter(clean);
      }, 200);
    }
    return true;
  }
  window.qarySearchRoute = routeBySearch;

  function setupHomeSearch() {
    var wrap = $('#s-home .search-wrap'); if (!wrap) return;
    once(wrap, 'qaryHome', function () {
      var input = wrap.querySelector('input');
      var spans = wrap.querySelectorAll('span'); var mic = null;
      spans.forEach(function (s) { if ((s.textContent || '').indexOf('🎙') !== -1) mic = s; });
      if (!mic) return;
      mic.classList.add('qary-mic-active'); mic.title = 'Buscar por voz';
      mic.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        if (!SR) { toast('🎙️ Voz no soportada'); return; }
        mic.classList.add('on');
        listenOnce().then(function (text) {
          mic.classList.remove('on');
          if (input) input.value = text;
          if (!routeBySearch(text, 'home')) {
            // Fallback: abrir Explore con el término
            nav('explore'); setTimeout(function () {
              var ei = $('#explore-search'); if (ei) ei.value = text;
              exploreFilter(text);
            }, 200);
          }
        }).catch(function (err) { mic.classList.remove('on'); toast('🎙️ ' + (err.message || 'error')); });
      }, true);
    });
  }

  function setupExploreSearch() {
    var wrap = $('#s-explore .search-wrap'); if (!wrap) return;
    once(wrap, 'qaryExplore', function () {
      var input = wrap.querySelector('input');
      if (input) {
        input.addEventListener('input', function () { exploreFilter(input.value); });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') routeBySearch(input.value, 'explore');
        });
      }
      if (!wrap.querySelector('.qary-mic-emb')) {
        var btn = ce('button', { type: 'button', class: 'qary-mic-emb', title: 'Buscar por voz' }, '🎙️');
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!SR) { toast('🎙️ Voz no soportada'); return; }
          btn.classList.add('on');
          listenOnce().then(function (text) {
            btn.classList.remove('on');
            if (input) input.value = text;
            routeBySearch(text, 'explore');
          }).catch(function (err) { btn.classList.remove('on'); toast('🎙️ ' + (err.message || 'error')); });
        });
        wrap.appendChild(btn);
      }
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     E. PANTALLAS DINÁMICAS
     ════════════════════════════════════════════════════════════════════════ */
  function ensureScreen(id, title, contentBuilder, opts) {
    opts = opts || {};
    var existing = document.getElementById('s-' + id);
    if (existing) {
      if (typeof contentBuilder === 'function') {
        var sc = existing.querySelector('.qary-rebuild');
        if (sc) sc.innerHTML = ''; // limpia para rebuild
        contentBuilder(existing.querySelector('.qary-rebuild') || existing);
      }
      return existing;
    }
    var scr = ce('div', { id: 's-' + id, class: 'scr', style: 'background:var(--bg);' });
    scr.innerHTML =
      '<div class="top-hd">' +
        '<div class="hd-row">' +
          '<button class="hd-back" onclick="back()" title="Volver">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>' +
          '</button>' +
          '<span class="hd-title">' + title + '</span>' +
          '<div style="width:36px"></div>' +
        '</div>' +
      '</div>' +
      '<div class="scroll qary-rebuild" style="padding:0 0 80px;"></div>';
    var shell = $('#shell') || document.body;
    shell.appendChild(scr);
    if (typeof contentBuilder === 'function') contentBuilder(scr.querySelector('.qary-rebuild'));
    return scr;
  }

  /* ─── E.1 s-viajes ─── */
  var DEMO_VIAJES = [
    { id:'v1', icon:'🚗', name:'Qary Standard · San Isidro', date:'Hace 2h', amount:'S/. 18.00', status:'completed' },
    { id:'v2', icon:'🏍️', name:'Qary Motos · Miraflores',    date:'Ayer 8:30 PM', amount:'S/. 9.00', status:'completed' },
    { id:'v3', icon:'🚐', name:'Qary XL · Aeropuerto',        date:'Hace 3 días', amount:'S/. 45.00', status:'completed' },
    { id:'v4', icon:'🛻', name:'Qary Luxury · Surco',          date:'Hace 5 días', amount:'S/. 85.00', status:'completed' },
    { id:'v5', icon:'🚕', name:'Qary Executive · La Molina',   date:'Hace 1 sem',  amount:'S/. 28.00', status:'cancelled' },
  ];
  function buildViajes(root) {
    var filters = ce('div', { class: 'qary-filter-bar' });
    ['Todos', 'Completados', 'Cancelados', 'Este mes', 'Este año'].forEach(function (f, i) {
      var c = ce('div', { class: 'qary-filter-chip' + (i === 0 ? ' on' : '') }, f);
      c.onclick = function () {
        $$('.qary-filter-chip', filters).forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on'); applyViajesFilter(f);
      };
      filters.appendChild(c);
    });
    root.appendChild(filters);
    var list = ce('div', { class: 'qary-list', id: 'qary-viajes-list' });
    root.appendChild(list);

    var stats = ce('div', { style: 'padding:0 18px 12px;color:var(--muted);font:600 12px Outfit,sans-serif;' });
    root.insertBefore(stats, filters);
    function render(items) {
      list.innerHTML = '';
      stats.textContent = items.length + ' viaje(s) · Total S/. ' +
        items.filter(function (x) { return x.status === 'completed'; })
          .reduce(function (s, x) { return s + parseFloat((x.amount || '0').replace(/[^\d.]/g, '')) || 0; }, 0).toFixed(2);
      if (!items.length) {
        list.appendChild(ce('div', { style: 'text-align:center;padding:24px;color:var(--muted);font-size:13px' }, '📭 Sin viajes en este filtro.'));
        return;
      }
      items.forEach(function (v) {
        var st = v.status === 'completed' ? '<span class="qary-badge ok">Completado</span>'
               : v.status === 'cancelled' ? '<span class="qary-badge fail">Cancelado</span>'
               : '<span class="qary-badge pend">Pendiente</span>';
        var item = ce('div', { class: 'qary-list-item' });
        item.innerHTML = '<div class="ico">' + v.icon + '</div>' +
          '<div class="body"><h5>' + v.name + '</h5><p>' + v.date + ' · ' + st + '</p></div>' +
          '<div class="meta">' + v.amount + '</div>';
        item.onclick = function () { nav('booking'); };
        list.appendChild(item);
      });
    }
    function applyViajesFilter(label) {
      var src = lsJson('qary_viajes', null) || DEMO_VIAJES;
      if (label === 'Todos') return render(src);
      if (label === 'Completados') return render(src.filter(function (x) { return x.status === 'completed'; }));
      if (label === 'Cancelados') return render(src.filter(function (x) { return x.status === 'cancelled'; }));
      render(src);
    }
    applyViajesFilter('Todos');
  }

  /* ─── E.2 s-referrals ─── */
  function buildReferrals(root) {
    var code = (window.APP && APP.referralCode) || ls('qary_ref_code', '') || ('QARY-' + Math.random().toString(36).slice(2, 8).toUpperCase());
    lsSet('qary_ref_code', code);
    var hd = ce('div', { style: 'padding:18px;text-align:center;' });
    hd.innerHTML =
      '<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">Tu código único</div>' +
      '<div style="font-size:28px;font-weight:900;color:var(--blue);letter-spacing:4px;font-family:monospace;">' + code + '</div>' +
      '<div style="font-size:12px;color:var(--muted);margin-top:6px;">Cada referido activo te da S/. 10 de crédito</div>';
    var btn = ce('button', { class: 'btn-pry', style: 'margin:14px 18px 8px;width:calc(100% - 36px);' }, '💬 Compartir mi código');
    btn.onclick = function () {
      openShareSheet({
        title: '🎁 Únete a QARY',
        text: '🎉 ¡Únete a QARY! Usa mi código ' + code + ' y obtén S/. 10 de bono. Descarga: https://qary.pe/app',
      });
    };
    root.appendChild(hd); root.appendChild(btn);

    var subtitle = ce('div', { style: 'padding:8px 18px;font:800 11px/1 Outfit,sans-serif;color:var(--navy);text-transform:uppercase;letter-spacing:.6px;' }, 'Personas a quienes compartiste');
    root.appendChild(subtitle);
    var list = ce('div', { class: 'qary-list', id: 'qary-refs-list' });
    root.appendChild(list);
    function render() {
      var refs = lsJson('qary_referrals', []);
      list.innerHTML = '';
      if (!refs.length) {
        list.appendChild(ce('div', { style: 'text-align:center;padding:24px;color:var(--muted);font-size:13px' }, '📭 Aún no has compartido tu código. Toca "Compartir" arriba.'));
        return;
      }
      refs.slice().reverse().forEach(function (r) {
        var canalEmoji = r.channel === 'whatsapp' ? '💬' : r.channel === 'sms' ? '✉️' : r.channel === 'email' ? '📧' : '🔗';
        var status = r.accepted ? '<span class="qary-badge ok">Aceptó</span>' : '<span class="qary-badge pend">Pendiente</span>';
        var item = ce('div', { class: 'qary-list-item' });
        item.innerHTML = '<div class="ico">' + canalEmoji + '</div>' +
          '<div class="body"><h5>' + (r.name || 'Contacto') + '</h5>' +
          '<p>' + r.channel + ' · ' + new Date(r.ts).toLocaleString('es-PE') + ' · ' + status + '</p></div>';
        list.appendChild(item);
      });
    }
    render();
    document.addEventListener('qary:referral', render);
  }
  window.qaryAddReferral = function (info) {
    var arr = lsJson('qary_referrals', []);
    arr.push({ name: info.name || 'Contacto', channel: info.channel || 'whatsapp', ts: Date.now(), accepted: false });
    lsJsonSet('qary_referrals', arr);
    try { document.dispatchEvent(new CustomEvent('qary:referral')); } catch (e) {}
  };

  /* ─── E.3 s-feed (Reciente Ver todo, sin pagos) ─── */
  function buildFeed(root) {
    var note = ce('div', { style: 'padding:14px 18px;color:var(--muted);font:600 12px Outfit,sans-serif;background:rgba(43,47,217,.04);border-bottom:1px solid var(--border);' }, '📜 Eventos recientes (los pagos se muestran en Pagos → Historial).');
    root.appendChild(note);
    var filters = ce('div', { class: 'qary-filter-bar' });
    ['Todo', 'Servicios', 'Cuenta', 'Bancarias', 'Citas'].forEach(function (f, i) {
      var c = ce('div', { class: 'qary-filter-chip' + (i === 0 ? ' on' : '') }, f);
      c.onclick = function () {
        $$('.qary-filter-chip', filters).forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on'); applyFilter(f);
      };
      filters.appendChild(c);
    });
    root.appendChild(filters);
    var list = ce('div', { class: 'qary-list', id: 'qary-feed-list' });
    root.appendChild(list);

    function render(items) {
      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(ce('div', { style: 'text-align:center;padding:24px;color:var(--muted);font-size:13px' }, '📭 Sin eventos por mostrar.'));
        return;
      }
      items.forEach(function (e) {
        var item = ce('div', { class: 'qary-list-item' });
        item.innerHTML = '<div class="ico">' + (e.icon || '•') + '</div>' +
          '<div class="body"><h5>' + e.title + '</h5><p>' + e.subtitle + '</p></div>' +
          '<div class="meta">' + new Date(e.ts).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) + '</div>';
        item.onclick = function () {
          if (e.kind === 'payment') nav('historial');     // pagos → Historial
          else if (e.kind === 'profile') nav('edit-profile');
          else if (e.kind === 'bank') nav('bcp-transfer');
          else if (e.kind === 'appt') nav('soporte');
          else if (e.kind === 'service') nav('booking');
        };
        list.appendChild(item);
      });
    }
    function getEvents() {
      var saved = lsJson('qary_feed', null);
      if (saved && saved.length) return saved;
      // Demo data
      var now = Date.now();
      return [
        { kind:'service', icon:'🚗', title:'Viaje Qary Standard',   subtitle:'San Isidro → Miraflores', ts: now - 2 * 3600e3 },
        { kind:'profile', icon:'👤', title:'Cambiaste tu nombre',   subtitle:'Miguel R. → Miguel Rodríguez', ts: now - 6 * 3600e3 },
        { kind:'bank',    icon:'🏦', title:'Transferencia BCP',     subtitle:'A *** 4521 · S/. 80', ts: now - 24 * 3600e3 },
        { kind:'appt',    icon:'📅', title:'Cita agendada',         subtitle:'Hospital · Mañana 10:00', ts: now - 30 * 3600e3 },
        { kind:'profile', icon:'🔒', title:'Cambiaste tu contraseña', subtitle:'desde dispositivo Android', ts: now - 48 * 3600e3 },
        { kind:'bank',    icon:'➕', title:'Cuenta bancaria agregada', subtitle:'Interbank *** 0098', ts: now - 72 * 3600e3 },
      ];
    }
    function applyFilter(label) {
      var src = getEvents().filter(function (e) { return e.kind !== 'payment'; });
      if (label === 'Todo') return render(src);
      if (label === 'Servicios') return render(src.filter(function (x) { return x.kind === 'service'; }));
      if (label === 'Cuenta') return render(src.filter(function (x) { return x.kind === 'profile'; }));
      if (label === 'Bancarias') return render(src.filter(function (x) { return x.kind === 'bank'; }));
      if (label === 'Citas') return render(src.filter(function (x) { return x.kind === 'appt'; }));
      render(src);
    }
    applyFilter('Todo');
  }
  window.qaryAddFeedEvent = function (e) {
    var arr = lsJson('qary_feed', null) || [];
    arr.unshift({ kind: e.kind || 'service', icon: e.icon || '•', title: e.title || '', subtitle: e.subtitle || '', ts: e.ts || Date.now() });
    lsJsonSet('qary_feed', arr.slice(0, 100));
    try { document.dispatchEvent(new CustomEvent('qary:feed-event', { detail: e })); } catch (err) {}
  };

  /* ─── E.4 s-transport-all (Inicio→Ver todo→Transporte: 8 tipos) ─── */
  function buildTransportAll(root) {
    var grid = ce('div', { style: 'padding:14px 18px;display:grid;grid-template-columns:1fr 1fr;gap:12px;' });
    TR_TYPES.forEach(function (t) {
      var card = ce('div', { class: 'qary-tr-card', 'data-tr-canon': t.canon, style: 'min-width:0;padding:18px 12px;' });
      card.innerHTML = '<div class="ico">' + t.emoji + '</div>' +
        '<div class="nm">Qary ' + t.canon + '</div>' +
        '<div class="pr">Desde S/. ' + t.from.toFixed(2) + ' · ' + t.eta + '</div>';
      card.onclick = function () {
        QaryTransport.set(t.canon);
        nav('map');
      };
      grid.appendChild(card);
    });
    root.appendChild(grid);
    QaryTransport.applyVisual();
  }

  /* ════════════════════════════════════════════════════════════════════════
     F. PERFIL: stats clickables + foto sync
     ════════════════════════════════════════════════════════════════════════ */
  function setupProfileStats() {
    var stats = $('#s-profile .prof-stats'); if (!stats) return;
    once(stats, 'qaryStats', function () {
      var items = stats.querySelectorAll('.pstat');
      if (items.length < 3) return;
      // Viajes
      items[0].style.cursor = 'pointer';
      items[0].addEventListener('click', function () {
        ensureScreen('viajes', 'Mis viajes', buildViajes); nav('viajes');
      });
      // Soles → redirige a Pagos→Historial (s-historial existente)
      items[1].style.cursor = 'pointer';
      items[1].addEventListener('click', function () { nav('historial'); });
      // Referidos
      items[2].style.cursor = 'pointer';
      items[2].addEventListener('click', function () {
        ensureScreen('referrals', 'Referidos', buildReferrals); nav('referrals');
      });
    });
  }

  function syncProfilePhoto(dataUrl) {
    if (!dataUrl) { try { dataUrl = ls('qary_profile_photo', ''); } catch (e) {} }
    if (!dataUrl) return;
    lsSet('qary_profile_photo', dataUrl);
    // Aplica a TODAS las ubicaciones donde se muestra la foto.
    var targets = [
      '#home-hd-avatar',
      '#prof-av-edit',
      '#s-profile .prof-av',
      '#s-payment .hd-avatar',
      '.hd-avatar[onclick*="profile"]',
      '[data-qary-photo]',
    ];
    targets.forEach(function (sel) {
      $$(sel).forEach(function (el) {
        // Limpia texto inicial (la "M" inicial), pone background-image
        el.textContent = '';
        el.style.backgroundImage = 'url(' + dataUrl + ')';
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      });
    });
    try { document.dispatchEvent(new CustomEvent('qary:profile-photo', { detail: { dataUrl: dataUrl } })); } catch (e) {}
  }
  window.qarySyncProfilePhoto = syncProfilePhoto;

  function hookPhotoUploader() {
    once(document.body, 'qaryPhotoHook', function () {
      // Wrap handleProfilePhoto del legacy: tras leer el File, sincroniza foto.
      var orig = window.handleProfilePhoto;
      window.handleProfilePhoto = function (inp) {
        var f = inp && inp.files && inp.files[0];
        if (f) {
          var rd = new FileReader();
          rd.onload = function (e) {
            syncProfilePhoto(e.target.result);
            window.qaryAddFeedEvent && qaryAddFeedEvent({
              kind: 'profile', icon: '📷', title: 'Cambiaste tu foto de perfil',
              subtitle: 'Sincronizada en Inicio, Pagos y Perfil', ts: Date.now(),
            });
          };
          rd.readAsDataURL(f);
        }
        if (typeof orig === 'function') {
          try { orig.apply(this, arguments); } catch (e) { L_('orig handleProfilePhoto', e); }
        }
      };
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     G. RECIENTES → VER TODO → s-feed
     ════════════════════════════════════════════════════════════════════════ */
  function hookRecientesVerTodo() {
    var recientesAnchor = $('#s-home .sec-title a[onclick*="qaryOpenRecientes"]');
    if (!recientesAnchor) return;
    once(recientesAnchor, 'qaryRec', function () {
      recientesAnchor.removeAttribute('onclick');
      recientesAnchor.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        ensureScreen('feed', 'Recientes', buildFeed); nav('feed');
      });
    });
    // Reemplaza también la función global por seguridad
    window.qaryOpenRecientes = function () { ensureScreen('feed', 'Recientes', buildFeed); nav('feed'); };
  }

  /* ════════════════════════════════════════════════════════════════════════
     H. NOTAS DE VOZ REALES en chat
     ════════════════════════════════════════════════════════════════════════ */
  var qaryRec = { stream: null, mr: null, chunks: [], active: false, t0: 0 };
  function startVoice() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Sample rate bajo + canales mono = menos latencia.
        channelCount: 1,
        sampleRate: 16000,
      },
    }).then(function (stream) {
      qaryRec.stream = stream;
      var mt = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(function (t) {
        return window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t);
      });
      qaryRec.mr = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);
      qaryRec.chunks = [];
      qaryRec.mr.ondataavailable = function (e) { if (e.data && e.data.size > 0) qaryRec.chunks.push(e.data); };
      qaryRec.mr.start(100);
      qaryRec.active = true; qaryRec.t0 = Date.now();
      vibrate(8);
    });
  }
  function stopVoiceAndAttach() {
    return new Promise(function (resolve) {
      if (!qaryRec.active || !qaryRec.mr) return resolve(null);
      qaryRec.mr.onstop = function () {
        var blob = new Blob(qaryRec.chunks, { type: qaryRec.mr.mimeType || 'audio/webm' });
        try { qaryRec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        qaryRec.active = false;
        var ms = Date.now() - qaryRec.t0;
        attachVoiceNote(blob, ms);
        resolve({ blob: blob, durationMs: ms });
      };
      qaryRec.mr.stop();
    });
  }
  function attachVoiceNote(blob, durationMs) {
    var msgs = $('#chat-msgs') || $('#s-chat .scroll'); if (!msgs) return;
    var url = URL.createObjectURL(blob);
    var bub = ce('div', { class: 'qary-voice-bubble' });
    var dur = (durationMs ? Math.round(durationMs / 1000) : 0);
    bub.innerHTML = '<span style="font-size:18px">🎤</span>' +
      '<audio controls preload="auto"></audio>' +
      '<span style="font-size:11px;color:var(--muted);">' + dur + 's</span>';
    bub.querySelector('audio').src = url;
    msgs.appendChild(bub);
    if (msgs.scrollTo) msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
    toast('🎤 Nota de voz enviada (' + dur + 's)');
  }
  window.qaryAttachVoiceNote = attachVoiceNote;

  // Reemplaza toggleAudioRec del legacy con grabación real.
  function hookToggleAudioRec() {
    once(document.body, 'qaryAudioRecHook', function () {
      window.toggleAudioRec = function () {
        var btn = $('#btn-audio-rec');
        if (qaryRec.active) {
          if (btn) btn.classList.remove('active');
          stopVoiceAndAttach();
        } else {
          if (!navigator.mediaDevices) { toast('🎙️ Sin acceso al micrófono'); return; }
          startVoice().then(function () {
            if (btn) btn.classList.add('active');
            toast('🎙️ Grabando… (toca de nuevo para enviar)');
          }).catch(function (err) { toast('🎙️ ' + (err.message || 'error de permisos')); });
        }
      };
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     I. PANEL IA: TTS Fem/Masc/Neutro + API key + Backend URL
     ════════════════════════════════════════════════════════════════════════ */
  function setupAIPanel() {
    var panel = $('#s-ai-panel .scroll');
    if (!panel || panel.querySelector('#qary-pr4-cfg')) return;
    var box = ce('div', { id: 'qary-pr4-cfg' });
    box.innerHTML =
      '<div class="qary-cfg-block">' +
        '<h4>🗣️ Voz del asistente</h4>' +
        '<div class="qary-tts-row" id="qary-tts-row">' +
          '<button data-g="female">Femenino</button>' +
          '<button data-g="male">Masculino</button>' +
          '<button data-g="neutral">Neutro</button>' +
        '</div>' +
      '</div>' +
      '<div class="qary-cfg-block">' +
        '<h4>🔑 API key del modelo</h4>' +
        '<label>Proveedor</label>' +
        '<select id="qary-provider">' +
          '<option value="anthropic">Anthropic (Claude)</option>' +
          '<option value="openai">OpenAI</option>' +
          '<option value="gemini">Google Gemini</option>' +
          '<option value="grok">Grok / xAI</option>' +
        '</select>' +
        '<label>API key</label>' +
        '<input type="password" id="qary-apikey" autocomplete="off" placeholder="sk-... / AIza..." />' +
        '<div class="actions">' +
          '<button class="pri" id="qary-apikey-save">Guardar</button>' +
          '<button class="sec" id="qary-apikey-clear">Borrar</button>' +
        '</div>' +
        '<p style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.4;">Se guarda solo en este dispositivo. Nunca se envía al backend de QARY.</p>' +
      '</div>' +
      '<div class="qary-cfg-block">' +
        '<h4>🌐 Backend (drivers, sockets)</h4>' +
        '<input type="url" id="qary-backend-url" placeholder="https://api.tu-backend.com" />' +
        '<div class="actions"><button class="pri" id="qary-backend-save">Conectar</button></div>' +
      '</div>';
    panel.appendChild(box);

    // TTS
    var ttsRow = box.querySelector('#qary-tts-row');
    function paintTTS(g) { ttsRow.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-g') === g); }); }
    paintTTS(ls('qary_voice_gender', 'female'));
    ttsRow.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-g]'); if (!b) return;
      var g = b.getAttribute('data-g'); paintTTS(g);
      if (typeof window.qarySetVoiceGender === 'function') window.qarySetVoiceGender(g);
      else lsSet('qary_voice_gender', g);
    });

    // API key
    var apiInp = box.querySelector('#qary-apikey'); var provInp = box.querySelector('#qary-provider');
    apiInp.value = ls('qary_ai_apikey', ''); provInp.value = ls('qary_ai_provider', 'anthropic');
    box.querySelector('#qary-apikey-save').onclick = function () {
      lsSet('qary_ai_apikey', apiInp.value.trim());
      lsSet('qary_ai_provider', provInp.value);
      toast('🔑 Guardada (' + provInp.value + ')');
    };
    box.querySelector('#qary-apikey-clear').onclick = function () {
      lsSet('qary_ai_apikey', ''); apiInp.value = ''; toast('🔑 Revocada');
    };

    // Backend URL
    var beInp = box.querySelector('#qary-backend-url'); beInp.value = BACKEND;
    box.querySelector('#qary-backend-save').onclick = function () {
      setBackend(beInp.value); toast('🌐 ' + (BACKEND || 'sin conexión')); connectRealtime();
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     J. MAPA REAL-TIME (Socket.IO)
     ════════════════════════════════════════════════════════════════════════ */
  var driverMarkers = {}; var io = null; var ioReady = false;
  function loadIO(cb) {
    if (window.io) return cb(window.io);
    var s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = function () { cb(window.io); };
    s.onerror = function () { cb(null); };
    document.head.appendChild(s);
  }
  function divIcon(type) {
    if (!window.L) return null;
    return window.L.divIcon({ className: '', html: '<div class="qary-drv-mk">' + metaOf(type).emoji + '</div>',
      iconSize: [36, 36], iconAnchor: [18, 18] });
  }
  function upsertDriver(p) {
    if (!window.APP || !window.APP.lmap || !window.L) return;
    var m = driverMarkers[p.driverId];
    if (!m) {
      var marker = window.L.marker([p.lat, p.lng], { icon: divIcon(p.vehicleType) }).addTo(window.APP.lmap);
      driverMarkers[p.driverId] = m = { marker: marker, type: p.vehicleType };
    } else {
      m.marker.setLatLng([p.lat, p.lng]);
      if (p.vehicleType && m.type !== p.vehicleType) { m.marker.setIcon(divIcon(p.vehicleType)); m.type = p.vehicleType; }
    }
    applyDriverFilter();
  }
  function applyDriverFilter() {
    var cur = QaryTransport.current;
    Object.keys(driverMarkers).forEach(function (k) {
      var m = driverMarkers[k]; var el = m.marker.getElement(); if (!el) return;
      var match = !cur || isCanonMatch(m.type, cur);
      el.style.display = match ? '' : 'none';
    });
  }
  QaryTransport.onChange(applyDriverFilter);
  function connectRealtime() {
    if (!BACKEND) { L_('no backend'); return; }
    loadIO(function (sio) {
      if (!sio) return;
      try { if (io) io.disconnect(); } catch (e) {}
      io = sio(BACKEND, { transports: ['websocket', 'polling'] });
      io.on('connect', function () { ioReady = true; io.emit('subscribe:drivers', QaryTransport.current); });
      io.on('driver:position', upsertDriver);
      io.on('disconnect', function () { ioReady = false; });
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     INSERTAR 4 TIPOS FALTANTES en el carrusel de Pedir (s-map .ride-types)
     y AÑADIR una sección "Transporte" en Inicio con "Ver todo"
     ════════════════════════════════════════════════════════════════════════ */
  function ensureExtraTransportRows() {
    // Carrusel en s-map (.rt). Si faltan tipos canónicos, añadelos.
    var map = $('#s-map'); if (!map) return;
    var carrousel = $('#s-map [class*="ride"], #s-map .ride-types, #s-map .rt') ?
      $('#s-map .rt').parentElement : null;
    if (!carrousel) return;
    once(carrousel, 'qaryRideExt', function () {
      var existing = {};
      $$('.rt[data-svc-key]', carrousel).forEach(function (el) { existing[el.getAttribute('data-svc-key')] = el; });
      // Mapeo canon→data-svc-key del legacy: usamos canon directo como data-svc-key.
      TR_TYPES.forEach(function (t) {
        // Si ya hay un .rt con cualquier alias, no duplicar.
        var hit = false;
        Object.keys(existing).forEach(function (k) {
          if (isCanonMatch(k, t.canon)) hit = true;
        });
        if (hit) return;
        var node = ce('div', { class: 'rt', 'data-svc-key': t.canon, onclick: 'pickRide(this,\'' + t.canon + '\',' + t.from + ',\'' + t.eta + '\')' });
        node.innerHTML = '<div class="rt-ico">' + t.emoji + '</div>' +
          '<div class="rt-nm">Qary ' + t.canon + '</div>' +
          '<div class="rt-tm">' + t.eta + '</div>';
        carrousel.appendChild(node);
      });
    });
  }

  function ensureHomeTransportSection() {
    var home = $('#s-home #home-scroll'); if (!home) return;
    if (home.querySelector('#qary-home-transport')) return;
    // Inserta después de la grid de servicios (la primera .svc-grid).
    var sec = ce('div', { id: 'qary-home-transport', class: 'sec', style: 'margin-top:18px;margin-bottom:11px;' });
    sec.innerHTML =
      '<div class="sec-title" style="padding:0 18px;display:flex;justify-content:space-between;align-items:center;">' +
      '<span>Transporte</span><a id="qary-home-transport-all">Ver todo</a></div>';
    var row = ce('div', { class: 'qary-tr-row' });
    // 4 iconos visibles principales en Home (Standard / Motos / XL / Executive) — el resto en "Ver todo".
    var four = ['Standard','Motos','XL','Executive'];
    four.forEach(function (canon) {
      var t = metaOf(canon);
      var card = ce('div', { class: 'qary-tr-card', 'data-tr-canon': t.canon });
      card.innerHTML = '<div class="ico">' + t.emoji + '</div>' +
        '<div class="nm">Qary ' + t.canon + '</div>' +
        '<div class="pr">Desde S/. ' + t.from.toFixed(2) + '</div>';
      card.onclick = function () { QaryTransport.set(t.canon); nav('map'); };
      row.appendChild(card);
    });
    var firstGrid = home.querySelector('.svc-grid');
    if (firstGrid && firstGrid.parentNode) {
      firstGrid.parentNode.insertBefore(sec, firstGrid.nextSibling);
      firstGrid.parentNode.insertBefore(row, sec.nextSibling);
    } else {
      home.appendChild(sec); home.appendChild(row);
    }
    var verTodo = sec.querySelector('#qary-home-transport-all');
    verTodo.onclick = function (ev) {
      ev.preventDefault();
      ensureScreen('transport-all', 'Transporte (8 tipos)', buildTransportAll);
      nav('transport-all');
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     INTEGRAR Compartir nativo en botones existentes del legacy
     ════════════════════════════════════════════════════════════════════════ */
  function hookShareButtons() {
    // Modal Referidos: añade los 4 canales como botones extras.
    var refModal = $('#referidos-modal');
    if (refModal) once(refModal, 'qaryRefShare', function () {
      var box = refModal.querySelector('.modal-box'); if (!box) return;
      // Reemplaza/extiende el botón "Compartir por WhatsApp" con sheet 4-canales.
      var oldBtn = box.querySelector('button[onclick*="shareReferral"]');
      if (oldBtn) {
        oldBtn.textContent = '📤 Compartir';
        oldBtn.onclick = function () {
          var code = ($('#referral-code') || {}).textContent || '';
          openShareSheet({
            title: '🎁 Únete a QARY',
            text: '🎉 ¡Únete a QARY! Usa mi código ' + code + ' y obtén S/. 10 de bono. Descarga: https://qary.pe/app',
          });
        };
      }
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     INIT loop con MutationObserver (idempotente)
     ════════════════════════════════════════════════════════════════════════ */
  function setupAll() {
    setupHomeSearch();
    setupExploreSearch();
    setupAIPanel();
    setupProfileStats();
    hookPhotoUploader();
    hookRecientesVerTodo();
    hookToggleAudioRec();
    hookShareButtons();
    ensureExtraTransportRows();
    ensureHomeTransportSection();
    QaryTransport.applyVisual();
    syncProfilePhoto();
  }

  function start() {
    setupAll();
    new MutationObserver(setupAll).observe(document.body, { childList: true, subtree: true });
    if (BACKEND) connectRealtime();
    L_('overlay v3 activo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    setTimeout(start, 0);
  }
})();
