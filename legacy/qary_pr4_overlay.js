/* ============================================================================
   QARY PR4 OVERLAY
   ============================================================================
   Se inyecta al final del HTML legacy (via copy-legacy.mjs). Añade/arregla
   features sin reescribir el HTML monolítico:
     1. Transportes unificados (selección persistente entre vistas)
     2. Mapa en tiempo real vía Socket.IO + filtro por tipo de transporte
     3. TTS configurable (Femenino/Masculino/Neutro) UI en panel IA
     4. API key del agente IA externo (Anthropic/OpenAI/Gemini/etc.)
     5. Buscadores con micrófono + redirección a pestañas
     6. Sincronización de foto de perfil (evento custom)
     7. Reproducción de notas de voz en chat
     8. Bridge nativo: window.QaryNative.openExternal(url) para wrapper Expo
============================================================================ */
(function () {
  'use strict';
  if (window.__qaryPR4) return; window.__qaryPR4 = true;
  var log = function () { try { console.log.apply(console, ['[QARY-PR4]'].concat([].slice.call(arguments))); } catch (e) {} };

  /* ─── Config ─── */
  var BACKEND = (function () {
    try { return localStorage.getItem('qary_backend_url') || ''; } catch (e) { return ''; }
  })();
  function setBackend(url) { try { localStorage.setItem('qary_backend_url', url); BACKEND = url; } catch (e) {} }
  window.qarySetBackend = setBackend;

  /* ─── Toast helper (reutiliza el del legacy si existe) ─── */
  function toast(msg) {
    if (typeof window.toast === 'function') return window.toast(msg);
    log(msg);
  }

  /* ─── Bridge nativo (Expo WebView) ─── */
  function postNative(payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (e) { log('postNative err', e); }
  }
  window.QaryNative = { postMessage: postNative };

  /* ════════════════════════════════════════════════════════════════════════
     1. TRANSPORTES UNIFICADOS — store con persistencia + visual sync
     ════════════════════════════════════════════════════════════════════════ */
  var TRANSPORT_KEY = 'qary_transport_v1';
  // Mapa de claves "home" del legacy → claves "rt" del legacy.
  // Home usa: Ride/Moto/XL/Exec. Map (rt) usa: Ride/Moto/XL/Exec. Pedir-form usa: std/cf/ex/lx/xl/moto/bike/mudanzas.
  var ALIASES = {
    Ride: ['std', 'Ride'], std: ['std', 'Ride'],
    Moto: ['moto', 'Moto'], moto: ['moto', 'Moto'],
    XL: ['xl', 'XL'], xl: ['xl', 'XL'],
    Exec: ['ex', 'Exec'], ex: ['ex', 'Exec'],
    cf: ['cf'], lx: ['lx'], bike: ['bike'], mudanzas: ['mudanzas'],
  };
  function canonicalize(key) {
    if (!key) return null;
    var a = ALIASES[key];
    return a ? a[0] : key;
  }
  function aliasesOf(key) {
    var a = ALIASES[key]; return a || [key];
  }

  var QaryTransport = {
    _listeners: [],
    get current() {
      try { return localStorage.getItem(TRANSPORT_KEY) || null; } catch (e) { return null; }
    },
    set: function (key) {
      var canon = canonicalize(key);
      try { localStorage.setItem(TRANSPORT_KEY, canon); } catch (e) {}
      this._applyVisual(canon);
      this._listeners.forEach(function (fn) { try { fn(canon); } catch (e) {} });
      try {
        document.dispatchEvent(new CustomEvent('qary:transport', { detail: { key: canon } }));
      } catch (e) {}
    },
    onChange: function (fn) { this._listeners.push(fn); },
    _applyVisual: function (canon) {
      var aliases = aliasesOf(canon);
      // Marca cualquier elemento con data-svc-key, data-svc-home o .rt[data-svc-key].
      var nodes = document.querySelectorAll('[data-svc-key],[data-svc-home]');
      nodes.forEach(function (el) {
        var key = el.getAttribute('data-svc-key') || el.getAttribute('data-svc-home');
        var match = aliases.indexOf(key) >= 0;
        el.classList.toggle('qary-tr-selected', match);
        if (el.classList.contains('rt')) {
          // El legacy ya usa .rt.sel — preservamos.
          el.classList.toggle('sel', match);
        }
      });
    },
  };
  window.QaryTransport = QaryTransport;

  // CSS para estado seleccionado
  var st = document.createElement('style');
  st.textContent = '.qary-tr-selected{outline:2px solid #2B2FD9;outline-offset:2px;border-radius:14px;'
    + 'box-shadow:0 4px 18px rgba(43,47,217,.25)}'
    + '.qary-tr-disabled{opacity:.45;pointer-events:none}'
    + '.qary-mic-btn{background:rgba(43,47,217,.1);border:none;color:#2B2FD9;border-radius:10px;'
    + 'width:34px;height:34px;cursor:pointer;font-size:16px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}'
    + '.qary-mic-btn.on{background:#FF2D78;color:#fff;animation:qaryMicPulse 1s ease-in-out infinite}'
    + '@keyframes qaryMicPulse{50%{box-shadow:0 0 0 6px rgba(255,45,120,.25)}}'
    + '.qary-tts-row{display:flex;gap:8px;margin-top:8px}.qary-tts-row button{flex:1;padding:10px;'
    + 'border:1.5px solid #EEEEF8;border-radius:10px;background:#fff;cursor:pointer;font-weight:700;font-family:Outfit,sans-serif}'
    + '.qary-tts-row button.on{background:linear-gradient(135deg,#2B2FD9,#FF2D78);color:#fff;border-color:transparent}'
    + '.qary-cfg-card{background:#fff;border:1.5px solid #EEEEF8;border-radius:14px;padding:14px;margin:10px 0}'
    + '.qary-cfg-card h4{font-size:13px;font-weight:800;color:#0D0B2E;margin:0 0 8px}'
    + '.qary-cfg-card input,.qary-cfg-card select{width:100%;padding:9px 12px;border:1.5px solid #EEEEF8;'
    + 'border-radius:10px;font-family:Outfit,sans-serif;font-size:13px;background:#F7F8FF;outline:none}'
    + '.qary-cfg-card input:focus{border-color:#2B2FD9;background:#fff}'
    + '.qary-driver-marker{width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
    + 'border-radius:50%;background:#fff;border:2px solid #2B2FD9;font-size:18px;'
    + 'box-shadow:0 4px 12px rgba(0,0,0,.18);transition:transform .9s linear}';
  document.head.appendChild(st);

  // Hook: cuando cualquier .rt o .svc-btn se toque, persiste el tipo seleccionado.
  document.addEventListener('click', function (e) {
    var rt = e.target.closest('[data-svc-key],[data-svc-home]');
    if (!rt) return;
    var key = rt.getAttribute('data-svc-key') || rt.getAttribute('data-svc-home');
    if (!key) return;
    QaryTransport.set(key);
  }, true);

  // Aplica el estado inicial cuando hay DOM ready.
  function init() {
    var cur = QaryTransport.current || 'std';
    QaryTransport._applyVisual(cur);
  }

  /* ════════════════════════════════════════════════════════════════════════
     2. MAPA REAL-TIME — Socket.IO + filtro por tipo
     ════════════════════════════════════════════════════════════════════════ */
  var driverMarkers = {}; // driverId → { marker, type }
  var io = null;
  var ioConnected = false;
  var typeIcons = { std: '🚗', cf: '🚙', ex: '🚕', lx: '🛻', xl: '🚐', moto: '🏍️', bike: '🚲', mudanzas: '🚛' };

  function loadSocketIO(cb) {
    if (window.io) return cb(window.io);
    var s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = function () { cb(window.io); };
    s.onerror = function () {
      log('socket.io CDN load failed; mapa quedará en modo demo random walk');
      cb(null);
    };
    document.head.appendChild(s);
  }

  function divIcon(type) {
    return window.L.divIcon({
      className: '',
      html: '<div class="qary-driver-marker">' + (typeIcons[type] || '🚗') + '</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function upsertDriver(p) {
    if (!window.APP || !window.APP.lmap || !window.L) return;
    var m = driverMarkers[p.driverId];
    if (!m) {
      var marker = window.L.marker([p.lat, p.lng], { icon: divIcon(p.vehicleType || 'std') });
      marker.addTo(window.APP.lmap);
      driverMarkers[p.driverId] = { marker: marker, type: p.vehicleType };
      m = driverMarkers[p.driverId];
    } else {
      m.marker.setLatLng([p.lat, p.lng]);
      if (p.vehicleType && m.type !== p.vehicleType) {
        m.marker.setIcon(divIcon(p.vehicleType));
        m.type = p.vehicleType;
      }
    }
    // Filtro: si hay tipo seleccionado, oculta los que no coincidan.
    var filter = QaryTransport.current;
    if (filter) {
      var match = aliasesOf(filter).indexOf(p.vehicleType) >= 0;
      m.marker.getElement() && (m.marker.getElement().style.display = match ? '' : 'none');
    }
  }

  function connectRealtime() {
    if (!BACKEND) {
      log('Backend no configurado — mapa real-time inactivo. Set qarySetBackend("https://api...") o configura en Settings.');
      return;
    }
    loadSocketIO(function (sio) {
      if (!sio) return;
      io = sio(BACKEND, { transports: ['websocket', 'polling'] });
      io.on('connect', function () {
        ioConnected = true;
        var cur = QaryTransport.current;
        io.emit('subscribe:drivers', cur);
        log('socket connected → drivers:positions' + (cur ? ':' + cur : ''));
      });
      io.on('driver:position', upsertDriver);
      io.on('disconnect', function () { ioConnected = false; });

      QaryTransport.onChange(function (key) {
        if (!io || !ioConnected) return;
        // Re-applies filter visually; the server emits a typed room too.
        Object.values(driverMarkers).forEach(function (m) {
          var match = aliasesOf(key).indexOf(m.type) >= 0;
          if (m.marker.getElement()) m.marker.getElement().style.display = match ? '' : 'none';
        });
      });
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     3 + 4. UI extra en panel IA: TTS gender + API key + Backend URL
     ════════════════════════════════════════════════════════════════════════ */
  function injectAIPanelExtras() {
    var panel = document.getElementById('s-ai-panel');
    if (!panel || panel.querySelector('#qary-pr4-cfg')) return;
    var card = document.createElement('div');
    card.id = 'qary-pr4-cfg';
    card.innerHTML =
      '<div class="qary-cfg-card">' +
        '<h4>🗣️ Voz del asistente</h4>' +
        '<div class="qary-tts-row" id="qary-tts-row">' +
          '<button data-g="female">Femenino</button>' +
          '<button data-g="male">Masculino</button>' +
          '<button data-g="neutral">Neutro</button>' +
        '</div>' +
      '</div>' +
      '<div class="qary-cfg-card">' +
        '<h4>🔑 API key del modelo (Anthropic / OpenAI / Gemini)</h4>' +
        '<input type="password" id="qary-apikey" placeholder="sk-ant-... / sk-... / AIza..." />' +
        '<select id="qary-provider" style="margin-top:8px">' +
          '<option value="anthropic">Anthropic</option>' +
          '<option value="openai">OpenAI</option>' +
          '<option value="gemini">Gemini</option>' +
          '<option value="grok">Grok</option>' +
        '</select>' +
        '<button class="btn-pry" style="margin-top:10px" id="qary-apikey-save">Guardar</button>' +
        '<p style="font-size:11px;color:#6B6B8A;margin-top:6px">' +
          'Se guarda en el dispositivo (localStorage). Usa "Borrar" para revocarla.' +
        '</p>' +
        '<button class="btn-sec" style="margin-top:6px" id="qary-apikey-clear">Borrar API key</button>' +
      '</div>' +
      '<div class="qary-cfg-card">' +
        '<h4>🌐 Backend URL (drivers en tiempo real, pagos)</h4>' +
        '<input type="url" id="qary-backend-url" placeholder="https://api.tu-backend.com" />' +
        '<button class="btn-pry" style="margin-top:10px" id="qary-backend-save">Conectar</button>' +
      '</div>';
    panel.appendChild(card);

    // Bind TTS buttons
    var ttsRow = card.querySelector('#qary-tts-row');
    function paintTTS(g) {
      ttsRow.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-g') === g);
      });
    }
    var savedG; try { savedG = localStorage.getItem('qary_voice_gender') || 'female'; } catch (e) { savedG = 'female'; }
    paintTTS(savedG);
    ttsRow.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-g]'); if (!b) return;
      var g = b.getAttribute('data-g');
      paintTTS(g);
      if (typeof window.qarySetVoiceGender === 'function') window.qarySetVoiceGender(g);
      else { try { localStorage.setItem('qary_voice_gender', g); } catch (e) {} }
    });

    // API key
    var apiInp = card.querySelector('#qary-apikey');
    var provInp = card.querySelector('#qary-provider');
    try {
      apiInp.value = localStorage.getItem('qary_ai_apikey') || '';
      provInp.value = localStorage.getItem('qary_ai_provider') || 'anthropic';
    } catch (e) {}
    card.querySelector('#qary-apikey-save').onclick = function () {
      try {
        localStorage.setItem('qary_ai_apikey', apiInp.value.trim());
        localStorage.setItem('qary_ai_provider', provInp.value);
        toast('🔑 API key guardada (' + provInp.value + ')');
      } catch (e) { toast('Error al guardar'); }
    };
    card.querySelector('#qary-apikey-clear').onclick = function () {
      try { localStorage.removeItem('qary_ai_apikey'); apiInp.value = ''; toast('🔑 API key revocada'); } catch (e) {}
    };

    // Backend URL
    var beInp = card.querySelector('#qary-backend-url');
    beInp.value = BACKEND;
    card.querySelector('#qary-backend-save').onclick = function () {
      var u = beInp.value.trim().replace(/\/$/, '');
      setBackend(u);
      toast('🌐 Backend: ' + (u || '(local)'));
      connectRealtime();
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     5. BUSCADORES con MICRÓFONO + REDIRECCIÓN
     ════════════════════════════════════════════════════════════════════════ */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listenOnce(lang) {
    return new Promise(function (resolve, reject) {
      if (!SR) return reject(new Error('no_speech'));
      var r = new SR(); r.lang = lang || 'es-PE'; r.interimResults = false; r.continuous = false;
      r.onresult = function (e) { resolve((e.results[0] && e.results[0][0] && e.results[0][0].transcript) || ''); };
      r.onerror = function (e) { reject(new Error(e.error || 'speech_error')); };
      r.start();
    });
  }

  // Mapa palabra → función nav() del legacy
  var SEARCH_ROUTES = [
    { rx: /comid|deliver|restaurant/i, screen: 'explore', filter: 'food' },
    { rx: /transport|taxi|uber|carro|moto|viaj/i, screen: 'map' },
    { rx: /merc|tiend|super/i, screen: 'explore', filter: 'market' },
    { rx: /pago|recibo|hist[oó]rico/i, screen: 'historial' },
    { rx: /soporte|ayuda|emergenc/i, screen: 'soporte' },
    { rx: /perfil|cuenta/i, screen: 'profile' },
    { rx: /premium|suscrip/i, screen: 'premium' },
    { rx: /chat|conductor/i, screen: 'chat' },
  ];
  function routeBySearch(text, scope) {
    var clean = (text || '').trim().toLowerCase();
    if (!clean) return false;
    var hit = SEARCH_ROUTES.find(function (r) { return r.rx.test(clean); });
    if (!hit) {
      toast('🔎 No se encontró elemento descrito: "' + text + '"');
      return false;
    }
    if (scope === 'explore' && hit.screen !== 'explore') {
      toast('🔎 No se encontró en Explorar — usa el buscador del Inicio');
      return false;
    }
    if (typeof window.nav === 'function') window.nav(hit.screen);
    if (hit.filter && typeof window.filterExplore === 'function') {
      // simula click sobre el chip correspondiente
      var chip = document.querySelector('.filter-chip[onclick*="' + hit.filter + '"]');
      if (chip) chip.click();
    }
    return true;
  }
  window.qarySearchRoute = routeBySearch;

  function attachMicTo(input, scope) {
    if (!input || input.dataset.qaryMic) return;
    input.dataset.qaryMic = '1';
    var btn = document.createElement('button');
    btn.className = 'qary-mic-btn'; btn.type = 'button'; btn.title = 'Buscar por voz'; btn.textContent = '🎙️';
    var parent = input.parentElement; if (!parent) return;
    parent.appendChild(btn);
    btn.onclick = function () {
      btn.classList.add('on');
      listenOnce().then(function (text) {
        btn.classList.remove('on');
        input.value = text;
        routeBySearch(text, scope);
      }).catch(function (err) {
        btn.classList.remove('on');
        toast('🎙️ ' + err.message);
      });
    };
    // Enter en el input también dispara routing
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') routeBySearch(input.value, scope);
    });
  }

  function attachSearches() {
    var home = document.querySelector('#s-home .search-wrap input');
    if (home) attachMicTo(home, 'home');
    var explore = document.querySelector('#s-explore .search-wrap input');
    if (explore) attachMicTo(explore, 'explore');
  }

  /* ════════════════════════════════════════════════════════════════════════
     6. SINCRONIZACIÓN DE FOTO DE PERFIL
     ════════════════════════════════════════════════════════════════════════ */
  function syncProfilePhoto(dataUrl) {
    try { localStorage.setItem('qary_profile_photo', dataUrl); } catch (e) {}
    document.querySelectorAll('[data-qary-photo],.hd-avatar,.profile-avatar,.payment-avatar')
      .forEach(function (el) {
        if (el.tagName === 'IMG') el.src = dataUrl;
        else el.style.backgroundImage = 'url(' + dataUrl + ')';
      });
    document.dispatchEvent(new CustomEvent('qary:profile-photo', { detail: { dataUrl: dataUrl } }));
  }
  window.qarySyncProfilePhoto = syncProfilePhoto;

  // Si hay foto guardada, aplícala al cargar
  function applyStoredPhoto() {
    try {
      var p = localStorage.getItem('qary_profile_photo');
      if (p) syncProfilePhoto(p);
    } catch (e) {}
  }

  /* ════════════════════════════════════════════════════════════════════════
     7. NOTAS DE VOZ — playback en chat
     ════════════════════════════════════════════════════════════════════════ */
  // Si el legacy expone una función global para empezar grabación de chat-audio,
  // envolvemos su finalización para auto-añadir un <audio> reproducible al chat.
  function attachVoiceNote(blob) {
    var msgs = document.querySelector('#chat-msgs') || document.querySelector('#s-chat .scroll');
    if (!msgs) return;
    var url = URL.createObjectURL(blob);
    var bubble = document.createElement('div');
    bubble.style.cssText = 'background:#fff;border-radius:14px;padding:8px 10px;margin:6px 0;display:inline-flex;align-items:center;gap:8px';
    bubble.innerHTML = '<span style="font-size:18px">🎤</span>';
    var audio = document.createElement('audio');
    audio.controls = true; audio.src = url; audio.style.maxWidth = '220px';
    bubble.appendChild(audio);
    msgs.appendChild(bubble);
    if (msgs.scrollTo) msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
  }
  window.qaryAttachVoiceNote = attachVoiceNote;

  /* ════════════════════════════════════════════════════════════════════════
     INIT
     ════════════════════════════════════════════════════════════════════════ */
  function start() {
    init();
    injectAIPanelExtras();
    attachSearches();
    applyStoredPhoto();
    connectRealtime();
    // Re-inyecta extras cuando el panel IA se vuelve visible (el legacy lo render lazy).
    var obs = new MutationObserver(function () {
      if (document.getElementById('s-ai-panel') && !document.getElementById('qary-pr4-cfg')) {
        injectAIPanelExtras();
      }
      attachSearches();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    log('overlay activo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    setTimeout(start, 0);
  }
})();
