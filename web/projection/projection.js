// L'ecran de projection : le plateau du MJ, en lecture seule, pour la salle.
//
// Le dessin reprend celui du plateau joueur de l'app (watched_board_panel.dart
// et board_token_view.dart) : memes formes, memes couleurs, memes cartes. Un
// changement la-bas doit se reporter ici, sans quoi la salle et les joueurs ne
// verraient pas le meme plateau.
//
// Ce script n'envoie jamais rien au serveur : il lit, et c'est tout. Le
// serveur, de son cote, coupe toute connexion qui tenterait d'ecrire.
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var token = location.pathname.split('/').filter(Boolean)[1];
  var base = '/projection/' + encodeURIComponent(token);
  var staticBase = '/projection/static/';

  // Les cartes et le pion que l'app embarque, avec leurs proportions.
  var BUILTIN_MAPS = {
    manoir: { image: staticBase + 'manoir-clairiere.jpg', ratio: 1312 / 1199 },
    grille: { image: null, ratio: 16 / 10 },
  };
  var BUILTIN_TOKENS = { grand_ancien: staticBase + 'grand-ancien.png' };

  var COLORS = {
    red: ['#EF5350', '#A3231F'],
    green: ['#8BC34A', '#4F7A1F'],
    blue: ['#4FB3E8', '#1F6F9C'],
    yellow: ['#FFD75E', '#C17F0E'],
  };

  var hosted = {};
  var assetsLoadedAt = 0;
  var board = null;
  var finished = false;
  var retryDelay = 1000;

  var frame = el('div', 'board');
  var mapLayer = el('div', 'map');
  var tokenLayer = el('div', 'tokens');
  frame.appendChild(mapLayer);
  frame.appendChild(tokenLayer);

  var banner = el('div', 'banner hidden');
  var fullscreen = el('button', 'fullscreen');
  fullscreen.type = 'button';
  fullscreen.textContent = 'Plein écran';
  fullscreen.addEventListener('click', toggleFullscreen);

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function showNotice(title, message) {
    finished = true;
    stage.className = 'notice';
    stage.textContent = '';
    var h = el('h1');
    h.textContent = title;
    var p = el('p');
    p.textContent = message;
    stage.appendChild(h);
    stage.appendChild(p);
  }

  function setBanner(message) {
    banner.textContent = message || '';
    banner.className = message ? 'banner' : 'banner hidden';
  }

  // --- Assets heberges ---

  function loadAssets() {
    assetsLoadedAt = Date.now();
    return fetch(base + '/assets', { credentials: 'omit' })
      .then(function (response) {
        return response.ok ? response.json() : { assets: [] };
      })
      .then(function (body) {
        var next = {};
        (body.assets || []).forEach(function (asset) {
          next[asset.key] = asset;
        });
        hosted = next;
        render();
      })
      .catch(function () {});
  }

  // Un MJ peut acheter une carte en pleine partie : une cle inconnue relance
  // la liste, mais pas plus d'une fois par demi-minute.
  function ensureKnown(keys) {
    var missing = keys.some(function (key) {
      return key && !BUILTIN_MAPS[key] && !BUILTIN_TOKENS[key] && !hosted[key];
    });
    if (missing && Date.now() - assetsLoadedAt > 30000) loadAssets();
  }

  function hostedImage(key) {
    return base + '/assets/' + encodeURIComponent(key) + '/image';
  }

  // Une carte inconnue rend la premiere, comme dans l'app : une carte achetee
  // peut arriver avant la liste qui la decrit.
  function mapFor(id) {
    if (id && BUILTIN_MAPS[id]) return BUILTIN_MAPS[id];
    var asset = id && hosted[id];
    if (asset && asset.kind === 'map') {
      var ratio = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 4 / 3;
      return { image: hostedImage(id), ratio: ratio };
    }
    return BUILTIN_MAPS.manoir;
  }

  // --- Dessin ---

  function render() {
    if (!board || finished) return;
    if (frame.parentNode !== stage) {
      stage.textContent = '';
      stage.className = '';
      stage.appendChild(frame);
      stage.appendChild(banner);
      stage.appendChild(fullscreen);
    }

    var map = mapFor(board.mapId);
    var bounds = stage.getBoundingClientRect();
    var margin = Math.min(bounds.width, bounds.height) * 0.03;
    var width = bounds.width - 2 * margin;
    var height = width / map.ratio;
    if (height > bounds.height - 2 * margin) {
      height = bounds.height - 2 * margin;
      width = height * map.ratio;
    }
    frame.style.width = width + 'px';
    frame.style.height = height + 'px';

    drawMap(map, width);

    var reference = Math.min(width, height);
    tokenLayer.textContent = '';
    board.tokens.forEach(function (t) {
      var side = t.size * reference;
      var node = drawToken(t);
      node.style.left = t.x * width - side / 2 + 'px';
      node.style.top = t.y * height - side / 2 + 'px';
      node.style.width = side + 'px';
      node.style.height = side + 'px';
      tokenLayer.appendChild(node);
    });
  }

  function drawMap(map, width) {
    var key = map.image || 'grid';
    if (mapLayer.dataset.key === key) {
      if (!map.image) mapLayer.style.backgroundSize = width / 12 + 'px ' + width / 12 + 'px';
      return;
    }
    mapLayer.dataset.key = key;
    mapLayer.textContent = '';
    mapLayer.className = 'map grid';
    mapLayer.style.backgroundSize = width / 12 + 'px ' + width / 12 + 'px';
    if (!map.image) return;

    var img = el('img');
    img.alt = '';
    img.src = map.image;
    // Une image qui ne vient pas laisse la grille : les pions restent a leur
    // place, comme dans l'app.
    img.addEventListener('load', function () {
      mapLayer.className = 'map';
    });
    img.addEventListener('error', function () {
      img.remove();
    });
    mapLayer.appendChild(img);
  }

  function drawToken(t) {
    var image = null;
    var kind = t.kind;
    var color = t.color;

    if (t.assetKey) {
      if (BUILTIN_TOKENS[t.assetKey]) {
        image = BUILTIN_TOKENS[t.assetKey];
      } else if (hosted[t.assetKey] && hosted[t.assetKey].kind !== 'map') {
        image = hostedImage(t.assetKey);
        kind = hosted[t.assetKey].kind;
        color = 'green';
      } else {
        // Un pion qu'on ne sait pas dessiner reste a sa place, en rond rouge.
        kind = 'character';
        color = 'red';
      }
    }

    if (!image) return shape(kind, color);

    var node = el('div', 'token illustrated');
    var img = el('img');
    img.alt = '';
    img.src = image;
    img.addEventListener('error', function () {
      var fallback = shape(kind, color);
      fallback.style.cssText = node.style.cssText;
      node.replaceWith(fallback);
    });
    node.appendChild(img);
    return node;
  }

  function shape(kind, color) {
    var palette = COLORS[color] || COLORS.red;
    var node = el('div', 'token');

    if (kind === 'zone_disc' || kind === 'zone_square') {
      node.classList.add(kind === 'zone_disc' ? 'zone-disc' : 'zone-square');
      return node;
    }

    if (kind === 'environment') {
      var svgNs = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      var path = document.createElementNS(svgNs, 'polygon');
      path.setAttribute('points', '50,0 100,100 0,100');
      path.setAttribute('fill', palette[0]);
      path.setAttribute('stroke', palette[1]);
      path.setAttribute('stroke-width', '4');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(path);
      node.appendChild(svg);
      return node;
    }

    var body = el('div', kind === 'effect' ? 'effect' : 'character');
    body.style.backgroundColor = palette[0];
    body.style.borderColor = palette[1];
    node.appendChild(body);
    return node;
  }

  // --- Temps reel ---

  function connect() {
    if (finished) return;
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var socket = new WebSocket(scheme + location.host + base + '/live');

    socket.addEventListener('message', function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (message.type === 'board') {
        retryDelay = 1000;
        setBanner(null);
        board = message.board;
        ensureKnown([board.mapId].concat(board.tokens.map(function (t) {
          return t.assetKey;
        })));
        render();
      } else if (message.type === 'closed') {
        showNotice('Projection terminée', message.message);
      } else if (message.type === 'error') {
        // Un lien revoque ou une seance finie ne reviendront pas : inutile
        // d'insister. Le reste est une panne, et se retente.
        if (message.status === 404 || message.status === 410 || message.status === 403) {
          showNotice('Projection indisponible', message.message);
        }
      }
    });

    socket.addEventListener('close', function () {
      if (finished) return;
      // Le plateau d'avant reste affiche : une coupure ne doit pas vider
      // l'ecran de la salle.
      setBanner(board ? 'Connexion perdue, reconnexion…' : null);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    });
  }

  // --- Plein ecran ---

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  }

  var idle;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(function () {
      document.body.classList.add('idle');
    }, 2500);
  }
  document.addEventListener('mousemove', wake);
  document.addEventListener('dblclick', toggleFullscreen);
  wake();

  window.addEventListener('resize', render);
  document.addEventListener('fullscreenchange', render);

  loadAssets();
  connect();
})();
