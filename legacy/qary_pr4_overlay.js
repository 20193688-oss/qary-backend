/* ============================================================================
   QARY PR4 OVERLAY v2 — reescrito tras feedback de UI
   ============================================================================
   Reglas:
   - IDEMPOTENTE: cada nodo se setupea UNA sola vez (data-qary-* flag).
   - NO duplicar iconos: reusa el 🎙️ existente en s-home, añade UNO solo en s-explore.
   - NO romper layout: usa los tokens del legacy (--navy, --blue, --muted, --border).
   - Comportamiento de búsqueda real: input de Explore filtra .prod-card en vivo;
     mic de Home dicta texto, abre Explore con el término precargado y filtra.
   - Transportes: sincroniza .svc-btn / .svc-big / .rt y muestra chip activo en s-map.
============================================================================ */
(function () {
  'use strict';
  if (window.__qaryPR4v2) return; window.__qaryPR4v2 = true;
  var L_ = function () { try { console.log.apply(console, ['[QARY-PR4]'].concat([].slice.call(arguments))); } catch (e) {} };

  /* ─── Helpers ─── */
  function $(s, root) { return (root || document).querySelector(s); }
  function $$(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }
  function on(el, ev, fn, opt) { if (el) el.addEventListener(ev, fn, opt || false); }
  function once(el, attr, fn) { if (!el || el.dataset[attr]) return; el.dataset[attr] = '1'; fn(el); }
  function toast(msg) {
    if (typeof window.toast === 'function') return window.toast(msg);
    L_(msg);
  }

  /* ─── Config / Backend URL ─── */
  var BACKEND = (function () {
    try { return localStorage.getItem('qary_backend_url') || ''; } catch (e) { return ''; }
  })();
  function setBackend(url) {
    BACKEND = (url || '').trim().replace(/\/$/, '');
    try { localStorage.setItem('qary_backend_url', BACKEND); } catch (e) {}
  }
  window.qarySetBackend = setBackend;

  /* ─── Bridge nativo (Expo WebView) ─── */
  function postNative(payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (e) {}
  }
  window.QaryNative = { postMessage: postNative };

  /* ════════════════════════════════════════════════════════════════════════
     ESTILOS
     ════════════════════════════════════════════════════════════════════════ */
  var styleEl = document.createElement('style');
  styleEl.id = 'qary-pr4-style';
  styleEl.textContent =
    /* Selección unificada de transportes */
    '.qary-tr-active{position:relative;}'+
    '.qary-tr-active::after{content:"";position:absolute;inset:-2px;border-radius:14px;'+
      'box-shadow:inset 0 0 0 2px #2B2FD9;pointer-events:none;}'+
    '.svc-btn.qary-tr-active{background:linear-gradient(135deg,rgba(43,47,217,.07),rgba(255,45,120,.04));}'+
    '.rt.qary-tr-active{background:rgba(43,47,217,.06);}'+
    '.svc-big.qary-tr-active{background:rgba(43,47,217,.06);}'+

    /* Chip activo en mapa */
    '#qary-tr-chip{position:absolute;top:14px;left:50%;transform:translateX(-50%);'+
      'background:rgba(13,11,46,.86);color:#fff;border-radius:99px;padding:6px 14px;'+
      'font:600 12px/1 Outfit,sans-serif;display:none;z-index:520;backdrop-filter:blur(8px);}'+
    '#qary-tr-chip.on{display:flex;align-items:center;gap:6px;}'+

    /* Mic button para search-wrap (solo Explore) */
    '.qary-mic-emb{flex-shrink:0;width:30px;height:30px;border-radius:50%;border:none;'+
      'background:rgba(43,47,217,.12);color:#2B2FD9;font-size:14px;cursor:pointer;'+
      'display:inline-flex;align-items:center;justify-content:center;transition:transform .12s;}'+
    '.qary-mic-emb:active{transform:scale(.85);}'+
    '.qary-mic-emb.on{background:#FF2D78;color:#fff;animation:qaryMicPulse 1s ease-in-out infinite;}'+
    '@keyframes qaryMicPulse{50%{box-shadow:0 0 0 6px rgba(255,45,120,.22)}}'+

    /* Hacer interactiva la mic emoji existente del Home */
    '#s-home .search-wrap span.qary-mic-active{color:#fff!important;cursor:pointer;'+
      'font-size:18px!important;background:rgba(255,255,255,.16);'+
      'border-radius:50%;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;}'+
    '#s-home .search-wrap span.qary-mic-active.on{background:#FF2D78;animation:qaryMicPulse 1s ease-in-out infinite;}'+

    /* Driver marker */
    '.qary-driver-marker{width:36px;height:36px;display:flex;align-items:center;justify-content:center;'+
      'border-radius:50%;background:#fff;border:2px solid #2B2FD9;font-size:18px;'+
      'box-shadow:0 4px 12px rgba(0,0,0,.18);transition:transform .9s linear;}'+

    /* Cards del panel IA con estilo legacy */
    '.qary-cfg-block{background:#fff;border:1.5px solid var(--border);border-radius:14px;'+
      'padding:14px;margin:14px 0;}'+
    '.qary-cfg-block h4{font:800 13px/1 Outfit,sans-serif;color:var(--navy);'+
      'text-transform:uppercase;letter-spacing:.6px;margin:0 0 10px;}'+
    '.qary-cfg-block label{display:block;font-size:11px;color:var(--muted);margin:8px 0 4px;font-weight:600;}'+
    '.qary-cfg-block input,.qary-cfg-block select{width:100%;padding:10px 12px;'+
      'border:1.5px solid var(--border);border-radius:10px;font:600 13px/1.2 Outfit,sans-serif;'+
      'background:#F7F8FF;color:var(--navy);outline:none;box-sizing:border-box;}'+
    '.qary-cfg-block input:focus,.qary-cfg-block select:focus{border-color:#2B2FD9;background:#fff;}'+
    '.qary-tts-row{display:flex;gap:6px;}'+
    '.qary-tts-row button{flex:1;padding:9px 6px;border:1.5px solid var(--border);'+
      'border-radius:10px;background:#fff;color:var(--navy);cursor:pointer;'+
      'font:700 12px/1.1 Outfit,sans-serif;}'+
    '.qary-tts-row button.on{background:linear-gradient(135deg,#2B2FD9,#FF2D78);'+
      'color:#fff;border-color:transparent;}'+
    '.qary-cfg-block .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}'+
    '.qary-cfg-block .actions{display:flex;gap:8px;margin-top:10px;}'+
    '.qary-cfg-block .actions button{flex:1;padding:10px;border-radius:10px;'+
      'font:700 12.5px/1.1 Outfit,sans-serif;cursor:pointer;border:1.5px solid var(--border);}'+
    '.qary-cfg-block .actions .pri{background:linear-gradient(135deg,#2B2FD9,#FF2D78);'+
      'color:#fff;border-color:transparent;}'+
    '.qary-cfg-block .actions .sec{background:#fff;color:var(--navy);}';
  document.head.appendChild(styleEl);

  /* ════════════════════════════════════════════════════════════════════════
     1. TRANSPORTES UNIFICADOS
     ════════════════════════════════════════════════════════════════════════ */
  var TR_KEY = 'qary_transport_v1';
  var ALIAS = {
    Ride: { canon: 'Ride', label: 'Qary Standard',  emoji: '🚗' },
    Standard: { canon: 'Ride', label: 'Qary Standard', emoji: '🚗' },
    std: { canon: 'Ride', label: 'Qary Standard', emoji: '🚗' },
    Moto:{ canon: 'Moto', label: 'Qary Moto',       emoji: '🏍️' },
    moto:{ canon: 'Moto', label: 'Qary Moto',       emoji: '🏍️' },
    XL:  { canon: 'XL',   label: 'Qary XL',         emoji: '🚐' },
    xl:  { canon: 'XL',   label: 'Qary XL',         emoji: '🚐' },
    Exec:{ canon: 'Exec', label: 'Qary Executive',  emoji: '🚕' },
    ex:  { canon: 'Exec', label: 'Qary Executive',  emoji: '🚕' },
    cf:  { canon: 'Confort', label: 'Qary Confort', emoji: '🚙' },
    Confort: { canon: 'Confort', label: 'Qary Confort', emoji: '🚙' },
    lx:  { canon: 'Luxury', label: 'Qary Luxury',   emoji: '🛻' },
    Luxury: { canon: 'Luxury', label: 'Qary Luxury', emoji: '🛻' },
    bike:{ canon: 'Bike', label: 'Qary Bike',       emoji: '🚲' },
    mudanzas:{ canon: 'Mudanzas', label: 'Qary Mudanzas', emoji: '🚛' },
    Med: { canon: 'Med',  label: 'Médico',          emoji: '🚑' },
  };
  function aliasMeta(key) { return ALIAS[key] || { canon: key, label: key, emoji: '🚗' }; }
  function canon(key) { return aliasMeta(key).canon; }
  function matchesCanon(rawKey, c) {
    var meta = aliasMeta(rawKey);
    return meta.canon === c;
  }

  var QaryTransport = {
    _listeners: [],
    get current() {
      try { return localStorage.getItem(TR_KEY) || null; } catch (e) { return null; }
    },
    set: function (rawKey) {
      var c = canon(rawKey);
      try { localStorage.setItem(TR_KEY, c); } catch (e) {}
      this.applyVisual();
      this._listeners.forEach(function (fn) { try { fn(c); } catch (e) {} });
      try { document.dispatchEvent(new CustomEvent('qary:transport', { detail: { key: c } })); } catch (e) {}
    },
    onChange: function (fn) { this._listeners.push(fn); },
    applyVisual: function () {
      var current = this.current;
      // .svc-btn[data-svc-home] (Home)
      $$('.svc-btn[data-svc-home],.rt[data-svc-key]').forEach(function (el) {
        var key = el.getAttribute('data-svc-home') || el.getAttribute('data-svc-key');
        var sel = current && matchesCanon(key, current);
        el.classList.toggle('qary-tr-active', !!sel);
      });
      // .svc-big sin data-attr — parseamos onclick="qaryHomeServiceTap('Ride')"
      $$('.svc-big[onclick*="qaryHomeServiceTap"]').forEach(function (el) {
        var m = /qaryHomeServiceTap\(['"]([^'"]+)['"]\)/.exec(el.getAttribute('onclick') || '');
        if (!m) return;
        var sel = current && matchesCanon(m[1], current);
        el.classList.toggle('qary-tr-active', !!sel);
      });
      // Chip activo en s-map
      var chip = document.getElementById('qary-tr-chip');
      var area = document.getElementById('map-area');
      if (area && !chip) {
        chip = document.createElement('div'); chip.id = 'qary-tr-chip';
        area.appendChild(chip);
      }
      if (chip) {
        if (current) {
          var meta = ALIAS[current] || aliasMeta(current);
          chip.innerHTML = '<span>' + meta.emoji + '</span><span>' + meta.label + '</span>';
          chip.classList.add('on');
        } else {
          chip.classList.remove('on');
        }
      }
    },
  };
  window.QaryTransport = QaryTransport;

  // Captura clicks (capture=true para correr antes que onclick inline) y persiste.
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-svc-home],[data-svc-key],.svc-big[onclick*="qaryHomeServiceTap"]');
    if (!el) return;
    var key = el.getAttribute('data-svc-home') || el.getAttribute('data-svc-key');
    if (!key) {
      var m = /qaryHomeServiceTap\(['"]([^'"]+)['"]\)/.exec(el.getAttribute('onclick') || '');
      key = m ? m[1] : null;
    }
    if (key) QaryTransport.set(key);
  }, true);

  /* ════════════════════════════════════════════════════════════════════════
     2. BÚSQUEDA — Home (mic en emoji existente) + Explore (input real)
     ════════════════════════════════════════════════════════════════════════ */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listenOnce(lang) {
    return new Promise(function (resolve, reject) {
      if (!SR) return reject(new Error('no_speech'));
      var r = new SR();
      r.lang = lang || 'es-PE'; r.interimResults = false; r.continuous = false;
      r.onresult = function (e) {
        var t = (e.results[0] && e.results[0][0] && e.results[0][0].transcript) || '';
        resolve(t.trim());
      };
      r.onerror = function (e) { reject(new Error(e.error || 'speech_error')); };
      r.start();
    });
  }

  // Tabla simple para enrutar términos a pestañas/filtros del legacy.
  var SEARCH_ROUTES = [
    { rx: /comid|deliver|restaurant|burguer|hambur|pizza|sushi|taco|food/i, screen: 'explore', filter: 'food' },
    { rx: /transport|taxi|carro|moto|viaj|llev[ao]|conduct|ride/i,           screen: 'map' },
    { rx: /merc|tiend|super|abarrot|market/i,                                screen: 'explore', filter: 'market' },
    { rx: /paquet|env[ií]o|express|courier/i,                                screen: 'explore', filter: 'express' },
    { rx: /hist[oó]ric|recibo|comprobant|movim/i,                            screen: 'historial' },
    { rx: /soport|ayud|emergenc|sos/i,                                       screen: 'soporte' },
    { rx: /perfil|cuenta|configur/i,                                         screen: 'profile' },
    { rx: /premium|suscrip|plan/i,                                           screen: 'premium' },
    { rx: /chat|conduct|mensaj/i,                                            screen: 'chat' },
    { rx: /pago|recargar|tarjet|wallet|saldo/i,                              screen: 'recarga' },
  ];
  function routeBySearch(text, scope) {
    var clean = (text || '').trim();
    if (!clean) return false;
    var hit = null;
    for (var i = 0; i < SEARCH_ROUTES.length; i++) {
      if (SEARCH_ROUTES[i].rx.test(clean.toLowerCase())) { hit = SEARCH_ROUTES[i]; break; }
    }
    if (scope === 'explore') {
      // Búsqueda dentro de Explore: filtra los productos in-place.
      qaryExploreFilter(clean);
      if (hit && hit.screen === 'explore' && hit.filter) {
        var chip = document.querySelector('.filter-chip[onclick*="\'' + hit.filter + '\'"]');
        if (chip) chip.click();
      }
      return true;
    }
    if (!hit) {
      toast('🔎 No se encontró elemento descrito: "' + clean + '"');
      return false;
    }
    if (typeof window.nav === 'function') window.nav(hit.screen);
    if (hit.screen === 'explore') {
      // Pre-carga el término y filtra
      setTimeout(function () {
        var inp = document.getElementById('explore-search');
        if (inp) inp.value = clean;
        if (hit.filter) {
          var chip = document.querySelector('.filter-chip[onclick*="\'' + hit.filter + '\'"]');
          if (chip) chip.click();
        }
        qaryExploreFilter(clean);
      }, 250);
    }
    return true;
  }
  window.qarySearchRoute = routeBySearch;

  // Filtro real de Explorar — oculta .prod-card que no matchean.
  function qaryExploreFilter(term) {
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
    var existing = document.getElementById('qary-explore-empty');
    if (!any && t) {
      if (!existing) {
        existing = document.createElement('div'); existing.id = 'qary-explore-empty';
        existing.style.cssText = 'text-align:center;padding:32px 16px;color:var(--muted);font-size:13px;';
        existing.textContent = '🔎 No se encontró elemento descrito';
        var scroll = document.getElementById('explore-scroll');
        if (scroll) scroll.appendChild(existing);
      }
    } else if (existing) {
      existing.remove();
    }
  }
  window.qaryExploreFilter = qaryExploreFilter;

  // HOME: reusa el 🎙️ que ya existe en .search-wrap. Hace clickable y captura voz.
  function setupHomeSearch() {
    var wrap = $('#s-home .search-wrap');
    if (!wrap) return;
    once(wrap, 'qaryHome', function () {
      var input = wrap.querySelector('input');
      var spans = wrap.querySelectorAll('span');
      // Buscar el span que contiene el emoji 🎙️ (último span suele serlo)
      var micEmoji = null;
      spans.forEach(function (s) {
        if ((s.textContent || '').indexOf('🎙') !== -1) micEmoji = s;
      });
      if (!micEmoji) return;
      micEmoji.classList.add('qary-mic-active');
      micEmoji.title = 'Buscar por voz';
      // Click en el mic NO debe disparar el onclick="nav('explore')" del padre
      micEmoji.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        if (!SR) { toast('🎙️ Reconocimiento de voz no soportado'); return; }
        micEmoji.classList.add('on');
        listenOnce().then(function (text) {
          micEmoji.classList.remove('on');
          if (input) input.value = text;
          routeBySearch(text, 'home');
        }).catch(function (err) {
          micEmoji.classList.remove('on');
          toast('🎙️ ' + (err.message || 'error'));
        });
      }, true);
    });
  }

  // EXPLORE: input real, agrega UN solo mic y enlaza filtro live.
  function setupExploreSearch() {
    var wrap = $('#s-explore .search-wrap');
    if (!wrap) return;
    once(wrap, 'qaryExplore', function () {
      var input = wrap.querySelector('input');
      if (input) {
        // Evita que se cree otro mic en re-render
        input.addEventListener('input', function () { qaryExploreFilter(input.value); });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') routeBySearch(input.value, 'explore');
        });
      }
      // Solo añade el mic si NO hay ya uno (idempotencia adicional)
      if (!wrap.querySelector('.qary-mic-emb')) {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'qary-mic-emb'; btn.textContent = '🎙️';
        btn.title = 'Buscar por voz';
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!SR) { toast('🎙️ Reconocimiento no soportado'); return; }
          btn.classList.add('on');
          listenOnce().then(function (text) {
            btn.classList.remove('on');
            if (input) input.value = text;
            routeBySearch(text, 'explore');
          }).catch(function (err) {
            btn.classList.remove('on');
            toast('🎙️ ' + (err.message || 'error'));
          });
        });
        wrap.appendChild(btn);
      }
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     3. PANEL IA — TTS + API key + Backend URL (estilo legacy)
     ════════════════════════════════════════════════════════════════════════ */
  function setupAIPanelExtras() {
    var panel = $('#s-ai-panel .scroll');
    if (!panel) return;
    if (panel.querySelector('#qary-pr4-cfg')) return;
    var box = document.createElement('div'); box.id = 'qary-pr4-cfg';
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
        '<p style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.4;">' +
          'La key se guarda en el dispositivo y nunca se envía al backend de QARY.' +
        '</p>' +
      '</div>' +
      '<div class="qary-cfg-block">' +
        '<h4>🌐 Backend (drivers, pagos, sockets)</h4>' +
        '<input type="url" id="qary-backend-url" placeholder="https://api.tu-backend.com" />' +
        '<div class="actions">' +
          '<button class="pri" id="qary-backend-save">Conectar</button>' +
        '</div>' +
      '</div>';
    panel.appendChild(box);

    // TTS
    var ttsRow = box.querySelector('#qary-tts-row');
    function paintTTS(g) {
      ttsRow.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-g') === g);
      });
    }
    var savedG = 'female';
    try { savedG = localStorage.getItem('qary_voice_gender') || 'female'; } catch (e) {}
    paintTTS(savedG);
    ttsRow.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-g]'); if (!b) return;
      var g = b.getAttribute('data-g');
      paintTTS(g);
      if (typeof window.qarySetVoiceGender === 'function') window.qarySetVoiceGender(g);
      else { try { localStorage.setItem('qary_voice_gender', g); } catch (e) {} }
    });

    // API key
    var apiInp = box.querySelector('#qary-apikey');
    var provInp = box.querySelector('#qary-provider');
    try {
      apiInp.value = localStorage.getItem('qary_ai_apikey') || '';
      provInp.value = localStorage.getItem('qary_ai_provider') || 'anthropic';
    } catch (e) {}
    box.querySelector('#qary-apikey-save').onclick = function () {
      try {
        localStorage.setItem('qary_ai_apikey', apiInp.value.trim());
        localStorage.setItem('qary_ai_provider', provInp.value);
        toast('🔑 API key guardada (' + provInp.value + ')');
      } catch (e) { toast('Error al guardar'); }
    };
    box.querySelector('#qary-apikey-clear').onclick = function () {
      try { localStorage.removeItem('qary_ai_apikey'); apiInp.value = ''; toast('🔑 Revocada'); } catch (e) {}
    };

    // Backend URL
    var beInp = box.querySelector('#qary-backend-url');
    beInp.value = BACKEND;
    box.querySelector('#qary-backend-save').onclick = function () {
      setBackend(beInp.value);
      toast('🌐 Backend: ' + (BACKEND || '(sin conexión)'));
      connectRealtime();
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     4. MAPA REAL-TIME (Socket.IO) — opcional, requiere Backend URL
     ════════════════════════════════════════════════════════════════════════ */
  var driverMarkers = {};
  var io = null, ioConnected = false;
  var typeIcons = { Ride:'🚗', Standard:'🚗', std:'🚗', Confort:'🚙', cf:'🚙',
    Exec:'🚕', ex:'🚕', Luxury:'🛻', lx:'🛻', XL:'🚐', xl:'🚐',
    Moto:'🏍️', moto:'🏍️', Bike:'🚲', bike:'🚲', Mudanzas:'🚛', mudanzas:'🚛', Med:'🚑' };

  function loadIO(cb) {
    if (window.io) return cb(window.io);
    var s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = function () { cb(window.io); };
    s.onerror = function () { L_('socket.io CDN failed'); cb(null); };
    document.head.appendChild(s);
  }

  function divIcon(type) {
    if (!window.L) return null;
    return window.L.divIcon({
      className: '',
      html: '<div class="qary-driver-marker">' + (typeIcons[type] || '🚗') + '</div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
  }

  function upsertDriver(p) {
    if (!window.APP || !window.APP.lmap || !window.L) return;
    var m = driverMarkers[p.driverId];
    if (!m) {
      var marker = window.L.marker([p.lat, p.lng], { icon: divIcon(p.vehicleType || 'std') });
      marker.addTo(window.APP.lmap);
      driverMarkers[p.driverId] = m = { marker: marker, type: p.vehicleType };
    } else {
      m.marker.setLatLng([p.lat, p.lng]);
      if (p.vehicleType && m.type !== p.vehicleType) {
        m.marker.setIcon(divIcon(p.vehicleType));
        m.type = p.vehicleType;
      }
    }
    applyDriverFilter();
  }

  function applyDriverFilter() {
    var current = QaryTransport.current;
    Object.keys(driverMarkers).forEach(function (k) {
      var m = driverMarkers[k]; var el = m.marker.getElement();
      if (!el) return;
      var match = !current || matchesCanon(m.type, current);
      el.style.display = match ? '' : 'none';
    });
  }

  function connectRealtime() {
    if (!BACKEND) { L_('No backend configurado'); return; }
    loadIO(function (sio) {
      if (!sio) return;
      try { if (io) io.disconnect(); } catch (e) {}
      io = sio(BACKEND, { transports: ['websocket', 'polling'] });
      io.on('connect', function () {
        ioConnected = true;
        io.emit('subscribe:drivers', QaryTransport.current);
        L_('socket connected');
      });
      io.on('driver:position', upsertDriver);
      io.on('disconnect', function () { ioConnected = false; });
    });
  }
  QaryTransport.onChange(applyDriverFilter);

  /* ════════════════════════════════════════════════════════════════════════
     5. SINCRONIZACIÓN FOTO PERFIL + UTILIDAD NOTAS DE VOZ
     ════════════════════════════════════════════════════════════════════════ */
  function syncProfilePhoto(dataUrl) {
    try { localStorage.setItem('qary_profile_photo', dataUrl); } catch (e) {}
    $$('[data-qary-photo],.hd-avatar,.profile-avatar,.payment-avatar').forEach(function (el) {
      if (el.tagName === 'IMG') el.src = dataUrl;
      else el.style.backgroundImage = 'url(' + dataUrl + ')';
    });
    try { document.dispatchEvent(new CustomEvent('qary:profile-photo', { detail: { dataUrl: dataUrl } })); } catch (e) {}
  }
  window.qarySyncProfilePhoto = syncProfilePhoto;
  function applyStoredPhoto() {
    try { var p = localStorage.getItem('qary_profile_photo'); if (p) syncProfilePhoto(p); } catch (e) {}
  }

  function attachVoiceNote(blob) {
    var msgs = $('#chat-msgs') || $('#s-chat .scroll');
    if (!msgs) return;
    var url = URL.createObjectURL(blob);
    var bubble = document.createElement('div');
    bubble.style.cssText = 'background:#fff;border-radius:14px;padding:8px 10px;margin:6px 0;display:inline-flex;align-items:center;gap:8px;max-width:80%;';
    bubble.innerHTML = '<span style="font-size:18px">🎤</span>';
    var audio = document.createElement('audio');
    audio.controls = true; audio.src = url; audio.style.maxWidth = '220px';
    bubble.appendChild(audio);
    msgs.appendChild(bubble);
    if (msgs.scrollTo) msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
  }
  window.qaryAttachVoiceNote = attachVoiceNote;

  /* ════════════════════════════════════════════════════════════════════════
     INIT — idempotente, observa cambios de DOM (legacy renderiza pantallas)
     ════════════════════════════════════════════════════════════════════════ */
  function setupAll() {
    setupHomeSearch();
    setupExploreSearch();
    setupAIPanelExtras();
    QaryTransport.applyVisual();
    applyStoredPhoto();
  }

  function start() {
    setupAll();
    var obs = new MutationObserver(function () { setupAll(); });
    obs.observe(document.body, { childList: true, subtree: true });
    if (BACKEND) connectRealtime();
    L_('overlay v2 activo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    setTimeout(start, 0);
  }
})();
