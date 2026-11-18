(function () {
  "use strict";

  var REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
  var COARSE_POINTER_QUERY = "(pointer: coarse)";

  function createMediaFlag(query) {
    if (typeof window.matchMedia !== "function") {
      return {
        matches: false,
        subscribe: function () {}
      };
    }
    var mql = window.matchMedia(query);
    return {
      get matches() {
        return Boolean(mql.matches);
      },
      subscribe: function (handler) {
        if (typeof mql.addEventListener === "function") {
          mql.addEventListener("change", handler);
        } else if (typeof mql.addListener === "function") {
          mql.addListener(handler);
        }
      }
    };
  }

  var reducedMotion = createMediaFlag(REDUCED_MOTION_QUERY);
  var coarsePointer = createMediaFlag(COARSE_POINTER_QUERY);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(current, target, factor) {
    return current + (target - current) * factor;
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function decodeBase32(input) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    var cleaned = String(input || "")
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, "");
    var bits = 0;
    var value = 0;
    var output = [];

    for (var i = 0; i < cleaned.length; i += 1) {
      var idx = alphabet.indexOf(cleaned.charAt(i));
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(output);
  }

  /* ------------------------------------------------------------------------
   * 0. Shared Active-Scroll Gate (Suppresses Synthetic Pointer Jitter)
   * ---------------------------------------------------------------------- */
  var SCROLL_IDLE_MS = 150;
  var isActivelyScrolling = false;
  var scrollIdleTimer = 0;
  var scrollStartListeners = [];
  var scrollEndListeners = [];

  function onScrollActivityStart(fn) {
    scrollStartListeners.push(fn);
  }

  function onScrollActivityEnd(fn) {
    scrollEndListeners.push(fn);
  }

  function finishScrollActivity() {
    scrollIdleTimer = 0;
    if (!isActivelyScrolling) return;
    isActivelyScrolling = false;
    for (var i = 0; i < scrollEndListeners.length; i += 1) {
      scrollEndListeners[i]();
    }
  }

  function markScrollActivity() {
    if (!isActivelyScrolling) {
      isActivelyScrolling = true;
      for (var i = 0; i < scrollStartListeners.length; i += 1) {
        scrollStartListeners[i]();
      }
    }
    if (scrollIdleTimer) {
      window.clearTimeout(scrollIdleTimer);
    }
    scrollIdleTimer = window.setTimeout(finishScrollActivity, SCROLL_IDLE_MS);
  }

  function initActiveScrollTracker() {
    window.addEventListener("scroll", markScrollActivity, { passive: true });
    window.addEventListener("wheel", markScrollActivity, { passive: true });
  }

  function getEventPageX(event) {
    if (typeof event.pageX === "number" && (event.pageX !== 0 || event.clientX === 0)) {
      return event.pageX;
    }
    return event.clientX + (window.scrollX || window.pageXOffset || 0);
  }

  function getEventPageY(event) {
    if (typeof event.pageY === "number" && (event.pageY !== 0 || event.clientY === 0)) {
      return event.pageY;
    }
    return event.clientY + (window.scrollY || window.pageYOffset || 0);
  }

  /* ------------------------------------------------------------------------
   * 1. Top Scroll-Progress Laser Bar (#jala-scroll-progress)
   *    Zero :root style mutations · Zero layout reads inside scroll rAF
   * ---------------------------------------------------------------------- */
  function initScrollProgressLaser() {
    var bar = document.getElementById("jala-scroll-progress");
    var root = document.documentElement;
    if (root && root.style) {
      root.style.removeProperty("--scroll-ratio");
    }
    if (!bar) return;

    var cachedMaxScroll = 0;
    var lastTransform = "";
    var ticking = false;
    var resizeTimer = 0;

    function applyTransformFromCachedBounds() {
      ticking = false;
      var scrollTop = window.scrollY || window.pageYOffset || 0;
      var ratio = cachedMaxScroll > 0 ? clamp(scrollTop / cachedMaxScroll, 0, 1) : 0;
      var nextTransform = "scaleX(" + ratio.toFixed(4) + ")";
      if (nextTransform !== lastTransform) {
        lastTransform = nextTransform;
        bar.style.transform = nextTransform;
      }
    }

    function refreshMaxScroll() {
      var docHeight = Math.max(
        root ? root.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      var viewportHeight = window.innerHeight || (root ? root.clientHeight : 0) || 0;
      cachedMaxScroll = Math.max(0, docHeight - viewportHeight);
      requestUpdate();
    }

    function requestUpdate() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(applyTransformFromCachedBounds);
      }
    }

    function scheduleResizeRefresh() {
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(function () {
        resizeTimer = 0;
        refreshMaxScroll();
      }, 100);
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", scheduleResizeRefresh, { passive: true });
    window.addEventListener("load", refreshMaxScroll, { once: true, passive: true });

    if (typeof window.ResizeObserver === "function") {
      var docRo = new window.ResizeObserver(function () {
        refreshMaxScroll();
      });
      if (document.body) {
        docRo.observe(document.body);
      } else if (root) {
        docRo.observe(root);
      }
    }

    refreshMaxScroll();
  }

  /* ------------------------------------------------------------------------
   * 2. 60fps Canvas2D Zero-Trust Mesh & Encrypted Packet Constellation
   *    (canvas#jala-kinetic-canvas)
   * ---------------------------------------------------------------------- */
  function initKineticConstellation() {
    var canvas = document.getElementById("jala-kinetic-canvas");
    if (!canvas || typeof canvas.getContext !== "function") return null;

    var ctx = null;
    var desynchronizedSupported = false;
    try {
      ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (ctx) {
        desynchronizedSupported = true;
      }
    } catch (_err) {
      ctx = null;
    }
    if (!ctx) {
      ctx = canvas.getContext("2d");
    }
    if (!ctx) return null;

    function createRadialSprite(size, stops) {
      var off = document.createElement("canvas");
      off.width = size;
      off.height = size;
      var octx = off.getContext("2d");
      if (!octx) return null;
      var half = size * 0.5;
      var grad = octx.createRadialGradient(half, half, 0, half, half, half);
      for (var i = 0; i < stops.length; i += 1) {
        grad.addColorStop(stops[i][0], stops[i][1]);
      }
      octx.fillStyle = grad;
      octx.fillRect(0, 0, size, size);
      return off;
    }

    var sprites = {
      pktGold: createRadialSprite(48, [
        [0, "rgba(255, 244, 214, 0.95)"],
        [0.4, "rgba(243, 198, 111, 0.45)"],
        [1, "rgba(243, 198, 111, 0)"]
      ]),
      pktCyan: createRadialSprite(48, [
        [0, "rgba(242, 248, 255, 0.95)"],
        [0.4, "rgba(56, 189, 248, 0.45)"],
        [1, "rgba(37, 99, 235, 0)"]
      ]),
      pktEmerald: createRadialSprite(48, [
        [0, "rgba(236, 253, 245, 0.95)"],
        [0.4, "rgba(110, 231, 183, 0.45)"],
        [1, "rgba(16, 185, 129, 0)"]
      ]),
      haloWarm: createRadialSprite(64, [
        [0, "rgba(243, 198, 111, 1)"],
        [0.55, "rgba(37, 99, 235, 0.24)"],
        [1, "rgba(37, 99, 235, 0)"]
      ]),
      haloCool: createRadialSprite(64, [
        [0, "rgba(56, 189, 248, 1)"],
        [0.6, "rgba(37, 99, 235, 0.22)"],
        [1, "rgba(37, 99, 235, 0)"]
      ]),
      pointerField: createRadialSprite(128, [
        [0, "rgba(56, 189, 248, 0.09)"],
        [0.55, "rgba(37, 99, 235, 0.04)"],
        [1, "rgba(5, 8, 15, 0)"]
      ])
    };

    var COLOR_GOLD = "#F3C66F";
    var COLOR_CYAN = "#38BDF8";
    var COLOR_EMERALD = "#6EE7B7";
    var COLOR_BASTION = "#BAE6FD";
    var DASH_PATTERN = [4, 4];
    var EMPTY_DASH = [];
    var headScratch = { x: 0, y: 0 };
    var midScratch = { x: 0, y: 0 };
    var tailScratch = { x: 0, y: 0 };

    var state = {
      width: 0,
      height: 0,
      docLeft: 0,
      docTop: 0,
      dpr: 1,
      desynchronized: desynchronizedSupported,
      nodes: [],
      links: [],
      packets: [],
      rafId: 0,
      running: false,
      inViewport: true,
      pageVisible: !document.hidden,
      frameCount: 0,
      lastTs: 0,
      pointer: {
        active: false,
        targetX: 0,
        targetY: 0,
        x: 0,
        y: 0,
        energy: 0
      }
    };

    var publicSnapshot = {
      width: 0,
      height: 0,
      dpr: 1,
      desynchronized: desynchronizedSupported,
      nodesCount: 0,
      linksCount: 0,
      packetsCount: 0,
      frameCount: 0,
      running: false,
      reducedMotion: reducedMotion.matches
    };
    canvas.__jalaKineticState = publicSnapshot;

    function seededUnit(seed) {
      var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
      return x - Math.floor(x);
    }

    function updateLinkGeometry(link, a, b) {
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var ptsX = link.ptsX;
      var ptsY = link.ptsY;
      var count = 2;

      if (link.mode === 0 || Math.abs(dx) < 36 || Math.abs(dy) < 24) {
        ptsX[0] = a.x;
        ptsY[0] = a.y;
        ptsX[1] = b.x;
        ptsY[1] = b.y;
        count = 2;
      } else {
        var chamfer = Math.min(Math.abs(dx) * 0.34, Math.abs(dy) * 0.65, 44);
        var midX = a.x + dx * (link.bendSign > 0 ? 0.54 : 0.46);
        var dirX = dx >= 0 ? 1 : -1;
        var dirY = dy >= 0 ? 1 : -1;
        var halfChamfer = dirX * chamfer * 0.5;

        ptsX[0] = a.x;
        ptsY[0] = a.y;
        ptsX[1] = midX - halfChamfer;
        ptsY[1] = a.y;
        ptsX[2] = midX + halfChamfer;
        ptsY[2] = a.y + dirY * chamfer;
        ptsX[3] = midX + halfChamfer;
        ptsY[3] = b.y;
        ptsX[4] = b.x;
        ptsY[4] = b.y;
        count = 5;
      }

      link.ptCount = count;
      var segStart = link.segStart;
      var segLen = link.segLen;
      var segOriginIdx = link.segOriginIdx;
      var total = 0;
      var sCount = 0;

      for (var i = 0; i < count - 1; i += 1) {
        var sx = ptsX[i + 1] - ptsX[i];
        var sy = ptsY[i + 1] - ptsY[i];
        var len = Math.hypot(sx, sy);
        if (len > 0.01) {
          segOriginIdx[sCount] = i;
          segStart[sCount] = total;
          segLen[sCount] = len;
          sCount += 1;
          total += len;
        }
      }

      link.segCount = sCount;
      link.totalLength = total > 1 ? total : 1;
    }

    function sampleLinkInto(link, progress, out) {
      var sCount = link.segCount;
      if (sCount <= 0) {
        out.x = link.ptsX[0] || 0;
        out.y = link.ptsY[0] || 0;
        return;
      }

      var targetDist = clamp(progress, 0, 1) * link.totalLength;
      var segStart = link.segStart;
      var segLen = link.segLen;
      var segOriginIdx = link.segOriginIdx;
      var ptsX = link.ptsX;
      var ptsY = link.ptsY;

      for (var i = 0; i < sCount; i += 1) {
        var start = segStart[i];
        var len = segLen[i];
        if (targetDist <= start + len || i === sCount - 1) {
          var localT = clamp((targetDist - start) / len, 0, 1);
          var idx0 = segOriginIdx[i];
          var x0 = ptsX[idx0];
          var y0 = ptsY[idx0];
          out.x = x0 + (ptsX[idx0 + 1] - x0) * localT;
          out.y = y0 + (ptsY[idx0 + 1] - y0) * localT;
          return;
        }
      }
    }

    function rebuildTopology() {
      var w = state.width;
      var h = state.height;
      if (w < 40 || h < 40) return;

      var cols = w < 680 ? 4 : w < 1180 ? 5 : 6;
      var rows = h < 420 ? 3 : 4;
      var nodes = [];
      var padX = Math.min(92, w * 0.07);
      var padY = Math.min(68, h * 0.11);
      var usableW = Math.max(120, w - padX * 2);
      var usableH = Math.max(120, h - padY * 2);

      var idx = 0;
      for (var c = 0; c < cols; c += 1) {
        for (var r = 0; r < rows; r += 1) {
          idx += 1;
          var rx = seededUnit(idx * 3.17) - 0.5;
          var ry = seededUnit(idx * 7.91) - 0.5;
          var colRatio = cols > 1 ? c / (cols - 1) : 0.5;
          var rowRatio = rows > 1 ? r / (rows - 1) : 0.5;

          var baseX = padX + usableW * colRatio + rx * (usableW / cols) * 0.46;
          var baseY = padY + usableH * rowRatio + ry * (usableH / rows) * 0.48;

          var role = "relay";
          if (c === 0) {
            role = "operator";
          } else if (c === cols - 1 || (c === cols - 2 && r === 1)) {
            role = seededUnit(idx * 11.3) > 0.45 ? "vault" : "enclave";
          } else if ((c + r) % 2 === 0) {
            role = "bastion";
          }

          var coreColor =
            role === "vault"
              ? COLOR_GOLD
              : role === "enclave"
                ? COLOR_EMERALD
                : role === "bastion"
                  ? COLOR_BASTION
                  : COLOR_CYAN;

          nodes.push({
            id: idx - 1,
            col: c,
            row: r,
            baseX: clamp(baseX, 24, w - 24),
            baseY: clamp(baseY, 24, h - 24),
            x: clamp(baseX, 24, w - 24),
            y: clamp(baseY, 24, h - 24),
            boost: 0,
            role: role,
            isWarm: role === "vault" || role === "bastion",
            coreColor: coreColor,
            radius: role === "bastion" ? 3.5 : role === "vault" ? 3.8 : 2.5,
            phase: seededUnit(idx * 5.43) * Math.PI * 2,
            driftAmp: 2.2 + seededUnit(idx * 9.13) * 3.6,
            driftSpeed: 0.45 + seededUnit(idx * 2.71) * 0.55
          });
        }
      }

      var links = [];
      var linkSet = Object.create(null);

      function addLink(i, j, styleSeed) {
        if (i === j) return;
        var a = Math.min(i, j);
        var b = Math.max(i, j);
        var key = a + ":" + b;
        if (linkSet[key]) return;
        linkSet[key] = true;
        links.push({
          source: i,
          target: j,
          mode: styleSeed > 0.32 ? 1 : 0,
          bendSign: styleSeed > 0.66 ? 1 : -1,
          goldAccent: nodes[i].role === "vault" || nodes[j].role === "vault" || styleSeed > 0.78,
          ptsX: new Float32Array(5),
          ptsY: new Float32Array(5),
          segStart: new Float32Array(4),
          segLen: new Float32Array(4),
          segOriginIdx: new Uint8Array(4),
          ptCount: 0,
          segCount: 0,
          totalLength: 1
        });
      }

      for (var i = 0; i < nodes.length; i += 1) {
        var nA = nodes[i];
        var candidates = [];
        for (var j = 0; j < nodes.length; j += 1) {
          if (i === j) continue;
          var nB = nodes[j];
          var colDelta = nB.col - nA.col;
          if (colDelta < 0 || colDelta > 1) continue;
          if (colDelta === 0 && Math.abs(nB.row - nA.row) !== 1) continue;
          var dist = Math.hypot(nB.baseX - nA.baseX, nB.baseY - nA.baseY);
          candidates.push({ index: j, dist: dist });
        }
        candidates.sort(function (x, y) {
          return x.dist - y.dist;
        });
        var maxEdges = nA.role === "bastion" ? 2 : 1;
        for (var k = 0; k < Math.min(maxEdges, candidates.length); k += 1) {
          addLink(i, candidates[k].index, seededUnit((i + 1) * 13.7 + k * 4.1));
        }
      }

      var packetCount = clamp(Math.floor(links.length * 0.62), 8, 18);
      var packets = [];
      for (var p = 0; p < packetCount; p += 1) {
        var linkIndex = (p * 3 + 1) % Math.max(1, links.length);
        var isGold = links[linkIndex] && links[linkIndex].goldAccent;
        var palette = isGold ? "gold" : p % 4 === 0 ? "emerald" : "sapphire";
        packets.push({
          linkIndex: linkIndex,
          t: seededUnit((p + 1) * 19.31),
          speed: 0.14 + seededUnit((p + 1) * 8.17) * 0.16,
          palette: palette,
          color:
            palette === "gold"
              ? COLOR_GOLD
              : palette === "emerald"
                ? COLOR_EMERALD
                : COLOR_CYAN,
          glowRadius: palette === "gold" ? 7.5 : 6.5,
          sprite:
            palette === "gold"
              ? sprites.pktGold
              : palette === "emerald"
                ? sprites.pktEmerald
                : sprites.pktCyan
        });
      }

      state.nodes = nodes;
      state.links = links;
      state.packets = packets;
    }

    function syncCanvasSize() {
      var rect = canvas.getBoundingClientRect();
      var scrollX = window.scrollX || window.pageXOffset || 0;
      var scrollY = window.scrollY || window.pageYOffset || 0;
      state.docLeft = rect.left + scrollX;
      state.docTop = rect.top + scrollY;

      var parent = canvas.parentElement;
      var w = rect.width || (parent ? parent.clientWidth : 0) || window.innerWidth || 1280;
      var h = rect.height || (parent ? parent.clientHeight : 0) || 620;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      w = Math.max(1, Math.round(w));
      h = Math.max(1, Math.round(h));

      if (w === state.width && h === state.height && dpr === state.dpr) {
        return;
      }

      state.width = w;
      state.height = h;
      state.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildTopology();

      if (reducedMotion.matches && state.frameCount > 0) {
        renderFrame(0, 0, true);
      }
    }

    function renderFrame(timeSec, dtSec, isStaticFrame) {
      var w = state.width;
      var h = state.height;
      var nodes = state.nodes;
      if (w <= 0 || h <= 0 || !nodes.length) return;

      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);

      var ptr = state.pointer;
      if (isStaticFrame) {
        ptr.energy = 0;
      } else {
        ptr.x = lerp(ptr.x, ptr.targetX, 0.12);
        ptr.y = lerp(ptr.y, ptr.targetY, 0.12);
        ptr.energy = lerp(ptr.energy, ptr.active && !isActivelyScrolling ? 1 : 0, 0.08);
      }

      var proximityRadius = Math.min(260, Math.max(180, w * 0.18));

      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        var driftX = isStaticFrame
          ? 0
          : Math.cos(timeSec * node.driftSpeed + node.phase) * node.driftAmp;
        var driftY = isStaticFrame
          ? 0
          : Math.sin(timeSec * node.driftSpeed * 0.85 + node.phase) * node.driftAmp;

        var nx = node.baseX + driftX;
        var ny = node.baseY + driftY;
        var boost = 0;

        if (ptr.energy > 0.01) {
          var dx = ptr.x - nx;
          var dy = ptr.y - ny;
          var dist = Math.hypot(dx, dy);
          if (dist < proximityRadius && dist > 0.1) {
            boost = (1 - dist / proximityRadius) * ptr.energy;
            var pull = boost * 5.5;
            nx += (dx / dist) * pull;
            ny += (dy / dist) * pull;
          }
        }

        node.x = nx;
        node.y = ny;
        node.boost = boost;
      }

      var links = state.links;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (var l = 0; l < links.length; l += 1) {
        var link = links[l];
        var a = nodes[link.source];
        var b = nodes[link.target];
        updateLinkGeometry(link, a, b);

        var edgeBoost = a.boost > b.boost ? a.boost : b.boost;
        var baseAlpha = link.goldAccent ? 0.13 : 0.11;
        var alpha = clamp(baseAlpha + edgeBoost * 0.28, 0.08, 0.46);

        ctx.beginPath();
        ctx.moveTo(link.ptsX[0], link.ptsY[0]);
        for (var pIdx = 1; pIdx < link.ptCount; pIdx += 1) {
          ctx.lineTo(link.ptsX[pIdx], link.ptsY[pIdx]);
        }

        ctx.lineWidth = edgeBoost > 0.2 ? 1.25 : 1;
        ctx.strokeStyle = link.goldAccent ? COLOR_GOLD : COLOR_CYAN;
        ctx.globalAlpha = alpha;
        ctx.stroke();
      }

      var packets = state.packets;
      ctx.lineWidth = 1.85;

      for (var pk = 0; pk < packets.length; pk += 1) {
        var packet = packets[pk];
        var pLink = links[packet.linkIndex];
        if (!pLink) continue;

        if (!isStaticFrame) {
          packet.t = (packet.t + dtSec * packet.speed) % 1;
        }

        var tHead = packet.t;
        var tMid = Math.max(0, tHead - 0.042);
        var tTail = Math.max(0, tHead - 0.085);

        sampleLinkInto(pLink, tHead, headScratch);
        sampleLinkInto(pLink, tMid, midScratch);
        sampleLinkInto(pLink, tTail, tailScratch);

        ctx.strokeStyle = packet.color;
        ctx.globalAlpha = 0.34;
        ctx.beginPath();
        ctx.moveTo(tailScratch.x, tailScratch.y);
        ctx.lineTo(midScratch.x, midScratch.y);
        ctx.stroke();

        ctx.globalAlpha = 0.88;
        ctx.beginPath();
        ctx.moveTo(midScratch.x, midScratch.y);
        ctx.lineTo(headScratch.x, headScratch.y);
        ctx.stroke();

        var gRadius = packet.glowRadius;
        if (packet.sprite) {
          ctx.globalAlpha = 1;
          ctx.drawImage(
            packet.sprite,
            headScratch.x - gRadius,
            headScratch.y - gRadius,
            gRadius * 2,
            gRadius * 2
          );
        }
      }

      if (ptr.energy > 0.03 && !isStaticFrame) {
        var fieldRadius = proximityRadius * 0.72;
        if (sprites.pointerField) {
          ctx.globalAlpha = ptr.energy;
          ctx.drawImage(
            sprites.pointerField,
            ptr.x - fieldRadius,
            ptr.y - fieldRadius,
            fieldRadius * 2,
            fieldRadius * 2
          );
        }

        ctx.setLineDash(DASH_PATTERN);
        ctx.lineWidth = 1;
        var connected = 0;
        for (var v = 0; v < nodes.length && connected < 4; v += 1) {
          var targetNode = nodes[v];
          if (targetNode.boost <= 0.16) continue;
          connected += 1;
          ctx.globalAlpha = clamp(targetNode.boost * 0.55, 0.06, 0.45);
          ctx.strokeStyle = targetNode.isWarm ? COLOR_GOLD : COLOR_CYAN;
          ctx.beginPath();
          ctx.moveTo(ptr.x, ptr.y);
          ctx.lineTo(targetNode.x, targetNode.y);
          ctx.stroke();
        }
        ctx.setLineDash(EMPTY_DASH);
      }

      for (var n = 0; n < nodes.length; n += 1) {
        var nd = nodes[n];
        var pulse = isStaticFrame ? 0.5 : 0.5 + 0.5 * Math.sin(timeSec * 1.9 + nd.phase);
        var haloR = nd.radius * (3.4 + pulse * 0.9 + nd.boost * 2.2);
        var haloSprite = nd.isWarm ? sprites.haloWarm : sprites.haloCool;

        if (haloSprite) {
          ctx.globalAlpha = clamp(0.33 + nd.boost * 0.31, 0, 1);
          ctx.drawImage(haloSprite, nd.x - haloR, nd.y - haloR, haloR * 2, haloR * 2);
        }

        if (nd.isWarm) {
          ctx.globalAlpha = clamp(0.35 + nd.boost * 0.35, 0, 1);
          ctx.strokeStyle = nd.role === "vault" ? COLOR_GOLD : COLOR_CYAN;
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nd.radius + 3.2 + nd.boost * 1.8, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.globalAlpha = 1;
        ctx.fillStyle = nd.coreColor;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      state.frameCount += 1;
      publicSnapshot.width = state.width;
      publicSnapshot.height = state.height;
      publicSnapshot.dpr = state.dpr;
      publicSnapshot.nodesCount = nodes.length;
      publicSnapshot.linksCount = links.length;
      publicSnapshot.packetsCount = packets.length;
      publicSnapshot.frameCount = state.frameCount;
      publicSnapshot.running = state.running;
      publicSnapshot.reducedMotion = reducedMotion.matches;
    }

    function tick(ts) {
      if (!state.running) return;
      if (!state.lastTs) state.lastTs = ts;
      var dtSec = clamp((ts - state.lastTs) / 1000, 0.001, 0.05);
      state.lastTs = ts;

      renderFrame(ts / 1000, dtSec, false);
      state.rafId = window.requestAnimationFrame(tick);
    }

    function updateLoopState() {
      var shouldAnimate =
        !reducedMotion.matches && state.inViewport && state.pageVisible && state.width > 0;

      if (shouldAnimate && !state.running) {
        state.running = true;
        state.lastTs = 0;
        state.rafId = window.requestAnimationFrame(tick);
      } else if (!shouldAnimate && state.running) {
        state.running = false;
        if (state.rafId) {
          window.cancelAnimationFrame(state.rafId);
          state.rafId = 0;
        }
      }

      publicSnapshot.running = state.running;
      publicSnapshot.reducedMotion = reducedMotion.matches;

      if (reducedMotion.matches && state.width > 0) {
        renderFrame(0, 0, true);
      }
    }

    onScrollActivityStart(function () {
      state.pointer.active = false;
    });

    if (!coarsePointer.matches) {
      window.addEventListener(
        "pointermove",
        function (event) {
          if (
            isActivelyScrolling ||
            reducedMotion.matches ||
            !state.inViewport ||
            state.width <= 0
          ) {
            return;
          }
          var localX = getEventPageX(event) - state.docLeft;
          var localY = getEventPageY(event) - state.docTop;
          var inside =
            localX >= -40 &&
            localX <= state.width + 40 &&
            localY >= -40 &&
            localY <= state.height + 40;

          if (inside) {
            state.pointer.targetX = localX;
            state.pointer.targetY = localY;
            if (!state.pointer.active) {
              state.pointer.x = localX;
              state.pointer.y = localY;
            }
            state.pointer.active = true;
          } else {
            state.pointer.active = false;
          }
        },
        { passive: true }
      );

      document.addEventListener("pointerleave", function () {
        state.pointer.active = false;
      });
    }

    if (typeof window.ResizeObserver === "function") {
      var ro = new window.ResizeObserver(function () {
        syncCanvasSize();
        updateLoopState();
      });
      ro.observe(canvas);
      if (canvas.parentElement) {
        ro.observe(canvas.parentElement);
      }
    }
    window.addEventListener(
      "resize",
      function () {
        syncCanvasSize();
        updateLoopState();
      },
      { passive: true }
    );

    if (typeof window.IntersectionObserver === "function") {
      var io = new window.IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            if (entries[i].target === canvas) {
              state.inViewport = entries[i].isIntersecting;
            }
          }
          updateLoopState();
        },
        { threshold: 0 }
      );
      io.observe(canvas);
    }

    document.addEventListener("visibilitychange", function () {
      state.pageVisible = !document.hidden;
      updateLoopState();
    });

    reducedMotion.subscribe(function () {
      updateLoopState();
    });

    syncCanvasSize();
    if (!reducedMotion.matches) {
      renderFrame(0, 0.016, false);
    }
    updateLoopState();
    return state;
  }

  /* ------------------------------------------------------------------------
   * 3. 3D Perspective Hardware Stage Tilt & Parallax
   *    ([data-tilt-stage] + [data-parallax-depth])
   * ---------------------------------------------------------------------- */
  function initHardwareStageTilt() {
    var stages = Array.prototype.slice.call(document.querySelectorAll("[data-tilt-stage]"));
    if (!stages.length) return;

    var MAX_TILT_DEG = 2.0;
    var LERP_FACTOR = 0.095;
    var SCROLL_DECAY_FACTOR = 0.26;

    stages.forEach(function (stage) {
      var parallaxSpecs = Array.prototype.slice
        .call(stage.querySelectorAll("[data-parallax-depth]"))
        .map(function (el) {
          return {
            el: el,
            depthScale: (parseFloat(el.getAttribute("data-parallax-depth")) || 14) * 0.42
          };
        });

      var stageBounds = {
        docLeft: 0,
        docTop: 0,
        width: 0,
        height: 0,
        valid: false
      };

      var currentRx = 0;
      var currentRy = 0;
      var targetRx = 0;
      var targetRy = 0;
      var currentGx = 50;
      var currentGy = 50;
      var targetGx = 50;
      var targetGy = 50;
      var currentAlpha = 0;
      var targetAlpha = 0;
      var hovering = false;
      var rafId = 0;

      function cacheStageBounds() {
        var rect = stage.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          stageBounds.valid = false;
          return;
        }
        stageBounds.docLeft = rect.left + (window.scrollX || window.pageXOffset || 0);
        stageBounds.docTop = rect.top + (window.scrollY || window.pageYOffset || 0);
        stageBounds.width = rect.width;
        stageBounds.height = rect.height;
        stageBounds.valid = true;
      }

      function applyStageVars(rx, ry, gx, gy, glareAlpha) {
        var isZeroTilt = Math.abs(rx) < 0.001 && Math.abs(ry) < 0.001;
        stage.style.setProperty("--tilt-rx", isZeroTilt ? "0deg" : rx.toFixed(3) + "deg");
        stage.style.setProperty("--tilt-ry", isZeroTilt ? "0deg" : ry.toFixed(3) + "deg");
        stage.style.setProperty("--glare-x", gx.toFixed(2) + "%");
        stage.style.setProperty("--glare-y", gy.toFixed(2) + "%");
        stage.style.setProperty(
          "--glare-alpha",
          Math.abs(glareAlpha) < 0.001 ? "0" : glareAlpha.toFixed(3)
        );

        var normX = !isZeroTilt && MAX_TILT_DEG > 0 ? ry / MAX_TILT_DEG : 0;
        var normY = !isZeroTilt && MAX_TILT_DEG > 0 ? -rx / MAX_TILT_DEG : 0;

        for (var i = 0; i < parallaxSpecs.length; i += 1) {
          var spec = parallaxSpecs[i];
          var item = spec.el;
          var shiftX = normX * spec.depthScale;
          var shiftY = normY * spec.depthScale;
          if (Math.abs(shiftX) < 0.04 && Math.abs(shiftY) < 0.04) {
            item.style.setProperty("--parallax-x", "0px");
            item.style.setProperty("--parallax-y", "0px");
            item.style.translate = "";
          } else {
            var sx = shiftX.toFixed(2) + "px";
            var sy = shiftY.toFixed(2) + "px";
            item.style.setProperty("--parallax-x", sx);
            item.style.setProperty("--parallax-y", sy);
            item.style.translate = sx + " " + sy;
          }
        }
      }

      function step() {
        rafId = 0;
        if (reducedMotion.matches || coarsePointer.matches) {
          currentRx = 0;
          currentRy = 0;
          currentGx = 50;
          currentGy = 50;
          currentAlpha = 0;
          applyStageVars(0, 0, 50, 50, 0);
          return;
        }

        var factor = isActivelyScrolling ? SCROLL_DECAY_FACTOR : LERP_FACTOR;
        currentRx = lerp(currentRx, targetRx, factor);
        currentRy = lerp(currentRy, targetRy, factor);
        currentGx = lerp(currentGx, targetGx, factor * 1.35);
        currentGy = lerp(currentGy, targetGy, factor * 1.35);
        currentAlpha = lerp(currentAlpha, targetAlpha, factor * 1.2);

        var settledAtRest =
          !hovering &&
          targetRx === 0 &&
          targetRy === 0 &&
          Math.abs(currentRx) < 0.004 &&
          Math.abs(currentRy) < 0.004 &&
          Math.abs(currentAlpha) < 0.004;

        if (settledAtRest) {
          currentRx = 0;
          currentRy = 0;
          currentGx = 50;
          currentGy = 50;
          currentAlpha = 0;
          applyStageVars(0, 0, 50, 50, 0);
          return;
        }

        applyStageVars(currentRx, currentRy, currentGx, currentGy, currentAlpha);
        rafId = window.requestAnimationFrame(step);
      }

      function ensureAnimating() {
        if (!rafId) {
          rafId = window.requestAnimationFrame(step);
        }
      }

      function releaseTiltToRest() {
        hovering = false;
        targetRx = 0;
        targetRy = 0;
        targetGx = 50;
        targetGy = 50;
        targetAlpha = 0;
        stage.removeAttribute("data-tilt-active");
        if (
          Math.abs(currentRx) >= 0.001 ||
          Math.abs(currentRy) >= 0.001 ||
          Math.abs(currentAlpha) >= 0.001
        ) {
          ensureAnimating();
        } else if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
          applyStageVars(0, 0, 50, 50, 0);
        }
      }

      onScrollActivityStart(releaseTiltToRest);

      stage.addEventListener(
        "pointerenter",
        function (event) {
          if (
            isActivelyScrolling ||
            reducedMotion.matches ||
            coarsePointer.matches ||
            event.pointerType === "touch"
          ) {
            return;
          }
          cacheStageBounds();
        },
        { passive: true }
      );

      stage.addEventListener(
        "pointermove",
        function (event) {
          if (
            isActivelyScrolling ||
            reducedMotion.matches ||
            coarsePointer.matches ||
            event.pointerType === "touch"
          ) {
            return;
          }
          if (!stageBounds.valid) {
            cacheStageBounds();
          }
          if (!stageBounds.valid) return;

          var relX = clamp((getEventPageX(event) - stageBounds.docLeft) / stageBounds.width, 0, 1);
          var relY = clamp((getEventPageY(event) - stageBounds.docTop) / stageBounds.height, 0, 1);

          hovering = true;
          targetRy = (relX - 0.5) * 2 * MAX_TILT_DEG;
          targetRx = (0.5 - relY) * 2 * MAX_TILT_DEG;
          targetGx = relX * 100;
          targetGy = relY * 100;
          targetAlpha = 1;
          stage.setAttribute("data-tilt-active", "true");
          ensureAnimating();
        },
        { passive: true }
      );

      stage.addEventListener("pointerleave", releaseTiltToRest);

      if (typeof window.ResizeObserver === "function") {
        var stageRo = new window.ResizeObserver(function () {
          if (!isActivelyScrolling) {
            cacheStageBounds();
          } else {
            stageBounds.valid = false;
          }
        });
        stageRo.observe(stage);
      } else {
        window.addEventListener(
          "resize",
          function () {
            stageBounds.valid = false;
          },
          { passive: true }
        );
      }

      applyStageVars(0, 0, 50, 50, 0);
    });
  }

  /* ------------------------------------------------------------------------
   * 4. Cursor-Tracking Specular Spotlight Cards ([data-spotlight-card])
   *    Cached bounds on pointerenter/ResizeObserver · Frozen during scroll
   * ---------------------------------------------------------------------- */
  function initSpotlightCards() {
    var cards = Array.prototype.slice.call(document.querySelectorAll("[data-spotlight-card]"));
    if (!cards.length) return;

    var boundsByCard = new WeakMap();
    var rafId = 0;
    var activeCard = null;
    var pendingCard = null;
    var pendingPageX = 0;
    var pendingPageY = 0;

    function cacheCardBounds(card) {
      var rect = card.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      var record = {
        docLeft: rect.left + (window.scrollX || window.pageXOffset || 0),
        docTop: rect.top + (window.scrollY || window.pageYOffset || 0),
        width: rect.width,
        height: rect.height
      };
      boundsByCard.set(card, record);
      return record;
    }

    function clearActiveCard() {
      if (activeCard) {
        activeCard.style.setProperty("--spot-alpha", "0");
        activeCard.removeAttribute("data-spot-active");
        activeCard = null;
      }
    }

    function flushPointer() {
      rafId = 0;
      if (isActivelyScrolling || !pendingCard) return;

      var card = pendingCard;
      var bounds = boundsByCard.get(card);
      if (!bounds) {
        bounds = cacheCardBounds(card);
      }
      if (!bounds) return;

      if (activeCard && activeCard !== card) {
        activeCard.style.setProperty("--spot-alpha", "0");
        activeCard.removeAttribute("data-spot-active");
      }

      activeCard = card;
      var x = clamp(pendingPageX - bounds.docLeft, -24, bounds.width + 24);
      var y = clamp(pendingPageY - bounds.docTop, -24, bounds.height + 24);
      card.style.setProperty("--spot-x", x.toFixed(1) + "px");
      card.style.setProperty("--spot-y", y.toFixed(1) + "px");
      card.style.setProperty("--spot-alpha", "1");
      card.setAttribute("data-spot-active", "true");
    }

    onScrollActivityStart(function () {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      pendingCard = null;
      clearActiveCard();
    });

    var cardsRo =
      typeof window.ResizeObserver === "function"
        ? new window.ResizeObserver(function (entries) {
            for (var i = 0; i < entries.length; i += 1) {
              boundsByCard.delete(entries[i].target);
            }
          })
        : null;

    if (!cardsRo) {
      window.addEventListener(
        "resize",
        function () {
          for (var r = 0; r < cards.length; r += 1) {
            boundsByCard.delete(cards[r]);
          }
        },
        { passive: true }
      );
    }

    for (var i = 0; i < cards.length; i += 1) {
      (function (card) {
        card.style.setProperty("--spot-alpha", "0");
        if (cardsRo) {
          cardsRo.observe(card);
        }

        card.addEventListener(
          "pointerenter",
          function (event) {
            if (isActivelyScrolling || event.pointerType === "touch" || coarsePointer.matches) {
              return;
            }
            cacheCardBounds(card);
          },
          { passive: true }
        );

        card.addEventListener(
          "pointermove",
          function (event) {
            if (isActivelyScrolling || event.pointerType === "touch" || coarsePointer.matches) {
              return;
            }
            pendingCard = card;
            pendingPageX = getEventPageX(event);
            pendingPageY = getEventPageY(event);
            if (!rafId) {
              rafId = window.requestAnimationFrame(flushPointer);
            }
          },
          { passive: true }
        );

        card.addEventListener("pointerleave", function () {
          if (pendingCard === card) {
            pendingCard = null;
          }
          card.style.setProperty("--spot-alpha", "0");
          card.removeAttribute("data-spot-active");
          if (activeCard === card) {
            activeCard = null;
          }
        });
      })(cards[i]);
    }
  }

  /* ------------------------------------------------------------------------
   * 5. Live Real Web Crypto API (crypto.subtle) AES-256-GCM Playground
   *    (#jala-live-cipher)
   * ---------------------------------------------------------------------- */
  function initLiveCipherPlayground() {
    var root = document.getElementById("jala-live-cipher");
    var inputEl = document.getElementById("jala-cipher-input");
    if (!root && !inputEl) return;

    var scope = root || document;
    var saltEl = document.getElementById("jala-cipher-salt");
    var ivEl = document.getElementById("jala-cipher-iv");
    var tagEl = document.getElementById("jala-cipher-tag");
    var ciphertextEl = document.getElementById("jala-cipher-ciphertext");
    var metaEl = document.getElementById("jala-cipher-meta");
    var presetBtns = Array.prototype.slice.call(scope.querySelectorAll("[data-cipher-preset]"));
    var modeBtns = Array.prototype.slice.call(scope.querySelectorAll("[data-cipher-mode]"));
    var resealBtns = Array.prototype.slice.call(
      scope.querySelectorAll("#jala-cipher-reseal, [data-cipher-reseal]")
    );

    var PRESET_FALLBACKS = {
      rdp: "rdp://10.24.8.15:3389 • corp\\admin • NLA=strict",
      ssh: "ssh -J ops@bastion.ap-se:22 root@10.24.19.40",
      sftp: "sftp://deploy@10.24.30.12/srv/releases/v1.16.tar.zst",
      vnc: "vnc://10.24.12.40:5900 • Tight/AES-GCM-Enclave",
      totp: "otpauth://totp/JalaDesk:prod-bastion?algorithm=SHA256&digits=6",
      vault: '{"host":"10.24.8.15","proto":"rdp","mfa":"rfc6238","sync":"appDataFolder"}'
    };

    var KEY_MATERIAL_BY_MODE = {
      account: {
        secret: "JalaDesk::GoogleOAuthVault::v1::sub_109482716354920184",
        label: "Account Key"
      },
      passphrase: {
        secret: "JalaDesk::MasterPassphrase::v1::zero-knowledge-operator-enclave",
        label: "Master Passphrase"
      }
    };

    var activeMode = "account";
    for (var m = 0; m < modeBtns.length; m += 1) {
      if (
        modeBtns[m].getAttribute("aria-pressed") === "true" ||
        modeBtns[m].getAttribute("data-active") === "true" ||
        modeBtns[m].classList.contains("is-active")
      ) {
        activeMode = modeBtns[m].getAttribute("data-cipher-mode") || "account";
      }
    }

    var calibratedIterations = null;
    var runSequence = 0;
    var scrambleRaf = 0;
    var encoder = new TextEncoder();

    function syncModeButtons() {
      modeBtns.forEach(function (btn) {
        var mode = btn.getAttribute("data-cipher-mode");
        var isCurrent = mode === activeMode;
        btn.setAttribute("aria-pressed", isCurrent ? "true" : "false");
        if (isCurrent) {
          btn.setAttribute("data-active", "true");
          btn.classList.add("is-active");
        } else {
          btn.removeAttribute("data-active");
          btn.classList.remove("is-active");
        }
      });
    }

    function syncPresetButtons(matchedBtn) {
      presetBtns.forEach(function (btn) {
        var isCurrent = btn === matchedBtn;
        btn.setAttribute("aria-pressed", isCurrent ? "true" : "false");
        if (isCurrent) {
          btn.setAttribute("data-active", "true");
          btn.classList.add("is-active");
        } else {
          btn.removeAttribute("data-active");
          btn.classList.remove("is-active");
        }
      });
    }

    var baseKeyPromises = Object.create(null);
    var reusableSalt = new Uint8Array(16);
    var reusableIv = new Uint8Array(12);

    function getImportedBaseKey(subtle, modeKey, secret) {
      if (baseKeyPromises[modeKey]) {
        return baseKeyPromises[modeKey];
      }
      baseKeyPromises[modeKey] = subtle
        .importKey("raw", encoder.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"])
        .catch(function (err) {
          delete baseKeyPromises[modeKey];
          throw err;
        });
      return baseKeyPromises[modeKey];
    }

    function animateBase64Decode(targetEl, cipherBytes, finalBase64) {
      if (!targetEl) return;
      if (scrambleRaf) {
        window.cancelAnimationFrame(scrambleRaf);
        scrambleRaf = 0;
      }

      targetEl.setAttribute("data-ciphertext", finalBase64);

      if (
        isActivelyScrolling ||
        reducedMotion.matches ||
        !cipherBytes ||
        cipherBytes.length === 0
      ) {
        targetEl.textContent = finalBase64;
        return;
      }

      var len = cipherBytes.length;
      var durationMs = 160;
      var startTs = performance.now();
      var noiseBytes = new Uint8Array(len);
      var frameBytes = new Uint8Array(len);
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        window.crypto.getRandomValues(noiseBytes);
      }

      for (var i = 0; i < len; i += 1) {
        frameBytes[i] = i < 2 ? cipherBytes[i] : noiseBytes[i];
      }
      targetEl.textContent = bytesToBase64(frameBytes);

      function stepScramble(now) {
        if (isActivelyScrolling) {
          scrambleRaf = 0;
          targetEl.textContent = finalBase64;
          return;
        }
        var progress = clamp((now - startTs) / durationMs, 0, 1);
        if (progress >= 1) {
          scrambleRaf = 0;
          targetEl.textContent = finalBase64;
          return;
        }

        var lockedBytes = Math.floor(progress * len);
        var stepOffset = Math.floor(progress * 97);
        for (var b = 0; b < len; b += 1) {
          frameBytes[b] =
            b < lockedBytes ? cipherBytes[b] : (noiseBytes[b] + stepOffset + b * 13) & 0xff;
        }
        targetEl.textContent = bytesToBase64(frameBytes);
        scrambleRaf = window.requestAnimationFrame(stepScramble);
      }

      scrambleRaf = window.requestAnimationFrame(stepScramble);
    }

    async function runSeal(animateOutput) {
      var currentSeq = ++runSequence;
      var plaintext = inputEl ? inputEl.value : "rdp://10.24.8.15:3389 • corp\\admin";
      var plainBytes = encoder.encode(plaintext);
      var modeKey = KEY_MATERIAL_BY_MODE[activeMode] ? activeMode : "account";
      var modeSpec = KEY_MATERIAL_BY_MODE[modeKey];
      var subtle = window.crypto && window.crypto.subtle;

      if (!subtle || typeof window.crypto.getRandomValues !== "function") {
        if (metaEl) {
          metaEl.textContent = "Web Crypto API requires HTTPS or localhost Secure Context";
        }
        return;
      }

      try {
        window.crypto.getRandomValues(reusableSalt);
        window.crypto.getRandomValues(reusableIv);
        var saltHex = bytesToHex(reusableSalt);
        var ivHex = bytesToHex(reusableIv);

        var iterations = calibratedIterations || 100000;
        var t0 = performance.now();

        var baseKey = await getImportedBaseKey(subtle, modeKey, modeSpec.secret);

        var aesKey = await subtle.deriveKey(
          {
            name: "PBKDF2",
            salt: reusableSalt,
            iterations: iterations,
            hash: "SHA-256"
          },
          baseKey,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"]
        );

        var encryptedBuffer = await subtle.encrypt(
          {
            name: "AES-GCM",
            iv: reusableIv,
            tagLength: 128
          },
          aesKey,
          plainBytes
        );

        var elapsedMs = performance.now() - t0;

        if (calibratedIterations === null) {
          calibratedIterations = elapsedMs < 25 ? 100000 : 2500;
        }

        if (currentSeq !== runSequence) return;

        var sealedBytes = new Uint8Array(encryptedBuffer);
        var tagStart = Math.max(0, sealedBytes.length - 16);
        var tagBytes = sealedBytes.subarray(tagStart);
        var bodyBytes =
          sealedBytes.length > 16 ? sealedBytes.subarray(0, tagStart) : sealedBytes;
        var finalBase64 = bytesToBase64(bodyBytes);

        if (saltEl) saltEl.textContent = saltHex;
        if (ivEl) ivEl.textContent = ivHex;
        if (tagEl) tagEl.textContent = bytesToHex(tagBytes);

        if (animateOutput) {
          animateBase64Decode(ciphertextEl, bodyBytes, finalBase64);
        } else if (ciphertextEl) {
          ciphertextEl.setAttribute("data-ciphertext", finalBase64);
          ciphertextEl.textContent = finalBase64;
        }

        if (metaEl) {
          metaEl.textContent =
            "PBKDF2-SHA256 (" +
            iterations.toLocaleString("en-US") +
            " iter · " +
            modeSpec.label +
            ") · AES-256-GCM · " +
            plainBytes.length +
            " B → " +
            sealedBytes.length +
            " B · " +
            elapsedMs.toFixed(2) +
            " ms";
        }
        if (root) {
          root.setAttribute("data-cipher-ready", "true");
          root.setAttribute("data-cipher-mode-active", activeMode);
        }
      } catch (_err) {
        if (metaEl && currentSeq === runSequence) {
          metaEl.textContent = "AES-256-GCM enclave ready";
        }
      }
    }

    if (inputEl) {
      inputEl.addEventListener("input", function () {
        syncPresetButtons(null);
        runSeal(true);
      });
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var rawAttr = btn.getAttribute("data-cipher-preset") || "";
        var payloadAttr =
          btn.getAttribute("data-cipher-payload") || btn.getAttribute("data-cipher-value");
        var nextValue =
          payloadAttr ||
          PRESET_FALLBACKS[rawAttr.toLowerCase()] ||
          rawAttr ||
          btn.textContent.trim();

        if (inputEl && nextValue) {
          inputEl.value = nextValue;
        }
        syncPresetButtons(btn);
        runSeal(true);
      });
    });

    modeBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var nextMode = btn.getAttribute("data-cipher-mode") || "account";
        activeMode = KEY_MATERIAL_BY_MODE[nextMode] ? nextMode : "account";
        syncModeButtons();
        runSeal(true);
      });
    });

    resealBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        runSeal(true);
      });
    });

    syncModeButtons();
    runSeal(false);
  }

  /* ------------------------------------------------------------------------
   * 6A. Interactive Multi-Hop SSH Bastion Packet Simulator (#jala-live-tunnel)
   * ---------------------------------------------------------------------- */
  function initBastionTunnelSimulator() {
    var root = document.getElementById("jala-live-tunnel");
    var protoBtns = Array.prototype.slice.call(
      (root || document).querySelectorAll("[data-tunnel-proto]")
    );
    if (!root && !protoBtns.length) return;

    var badgeEl = document.getElementById("jala-tunnel-proto-badge");
    var routeEl = document.getElementById("jala-tunnel-route");
    var cipherEl = document.getElementById("jala-tunnel-cipher");
    var latencyEl = document.getElementById("jala-tunnel-latency");
    var svgEl = document.getElementById("jala-tunnel-svg");
    var hops = Array.prototype.slice.call((root || document).querySelectorAll("[data-tunnel-hop]"));

    var PROFILES = {
      rdp: {
        badge: "RDP :3389 · FreeRDP 3.x",
        route: "Workstation → ssh -J bastion.corp:22 → 10.24.8.15:3389",
        cipher: "SSHv2 chacha20-poly1305 + TLS 1.3 NLA",
        latency: "14.2 ms · 60 fps AVC444",
        accent: "#38BDF8"
      },
      vnc: {
        badge: "VNC :5900 · RFB 3.8",
        route: "Mobile Enclave → ssh -J bastion.corp:22 → 10.24.12.40:5900",
        cipher: "SSHv2 AES-256-GCM Tunnel · Tight/ZRLE",
        latency: "18.6 ms · Adaptive FrameSync",
        accent: "#60A5FA"
      },
      ssh: {
        badge: "SSH -J :22 · Multiplex PTY",
        route: "Operator CLI → bastion-01.ap-se:22 → prod-k8s-node-04:22",
        cipher: "Ed25519 HostKey · curve25519-sha256",
        latency: "9.4 ms · Zero-Drop Keepalive",
        accent: "#6EE7B7"
      },
      sftp: {
        badge: "SFTP v3 · Dual-Pane Stream",
        route: "Local Vault → ssh -J bastion.corp:22 → /srv/releases",
        cipher: "SSHv2 Subsystem · SHA-256 Integrity",
        latency: "11.8 ms · 312 MB/s Pipelined",
        accent: "#F3C66F"
      }
    };

    var hopTimers = [];

    function clearHopTimers() {
      while (hopTimers.length) {
        window.clearTimeout(hopTimers.pop());
      }
    }

    function triggerHopBurst() {
      clearHopTimers();

      if (root) {
        root.classList.remove("is-bursting");
      }
      if (svgEl) {
        svgEl.classList.remove("is-bursting");
      }

      if (!reducedMotion.matches) {
        window.requestAnimationFrame(function () {
          if (root) root.classList.add("is-bursting");
          if (svgEl) svgEl.classList.add("is-bursting");
        });
      } else {
        if (root) root.classList.add("is-bursting");
        if (svgEl) svgEl.classList.add("is-bursting");
      }

      hops.forEach(function (hop, index) {
        hop.setAttribute("data-active", "true");
        hop.style.setProperty("--hop-index", String(index));
        hop.classList.remove("is-pulsing");

        if (reducedMotion.matches) {
          hop.style.setProperty("--hop-energy", "1");
          return;
        }

        var startTimer = window.setTimeout(function () {
          hop.classList.add("is-pulsing");
          hop.style.setProperty("--hop-energy", "1");
        }, index * 85);

        var endTimer = window.setTimeout(function () {
          hop.classList.remove("is-pulsing");
          hop.style.setProperty("--hop-energy", "0.35");
        }, index * 85 + 420);

        hopTimers.push(startTimer, endTimer);
      });

      if (!reducedMotion.matches) {
        var settleTimer = window.setTimeout(function () {
          if (root) root.classList.remove("is-bursting");
          if (svgEl) svgEl.classList.remove("is-bursting");
        }, hops.length * 85 + 460);
        hopTimers.push(settleTimer);
      }
    }

    function selectProtocol(protoKey, clickedBtn, emitBurst) {
      var normalized = String(protoKey || "rdp").toLowerCase();
      var profile = PROFILES[normalized] || PROFILES.rdp;

      protoBtns.forEach(function (btn) {
        var key = String(btn.getAttribute("data-tunnel-proto") || "").toLowerCase();
        var isSelected = clickedBtn ? btn === clickedBtn : key === normalized;
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
        if (btn.getAttribute("role") === "tab") {
          btn.setAttribute("aria-selected", isSelected ? "true" : "false");
        }
        if (isSelected) {
          btn.setAttribute("data-active", "true");
          btn.classList.add("is-active");
        } else {
          btn.removeAttribute("data-active");
          btn.classList.remove("is-active");
        }
      });

      var customBadge = clickedBtn && clickedBtn.getAttribute("data-tunnel-badge");
      var customRoute = clickedBtn && clickedBtn.getAttribute("data-tunnel-route");
      var customCipher = clickedBtn && clickedBtn.getAttribute("data-tunnel-cipher");
      var customLatency = clickedBtn && clickedBtn.getAttribute("data-tunnel-latency");

      if (badgeEl) badgeEl.textContent = customBadge || profile.badge;
      if (routeEl) routeEl.textContent = customRoute || profile.route;
      if (cipherEl) cipherEl.textContent = customCipher || profile.cipher;
      if (latencyEl) latencyEl.textContent = customLatency || profile.latency;

      if (root) {
        root.setAttribute("data-current-proto", normalized);
        root.style.setProperty("--tunnel-accent", profile.accent);
      }

      if (emitBurst) {
        triggerHopBurst();
      } else {
        hops.forEach(function (hop, idx) {
          hop.setAttribute("data-active", "true");
          hop.style.setProperty("--hop-index", String(idx));
          hop.style.setProperty("--hop-energy", "0.35");
        });
      }
    }

    protoBtns.forEach(function (btn, index) {
      btn.addEventListener("click", function () {
        selectProtocol(btn.getAttribute("data-tunnel-proto"), btn, true);
      });

      btn.addEventListener("keydown", function (event) {
        var nextIdx = -1;
        if (event.key === "ArrowRight") {
          nextIdx = (index + 1) % protoBtns.length;
        } else if (event.key === "ArrowLeft") {
          nextIdx = (index - 1 + protoBtns.length) % protoBtns.length;
        }
        if (nextIdx !== -1) {
          event.preventDefault();
          var target = protoBtns[nextIdx];
          target.focus();
          selectProtocol(target.getAttribute("data-tunnel-proto"), target, true);
        }
      });
    });

    var initialBtn = null;
    for (var i = 0; i < protoBtns.length; i += 1) {
      if (
        protoBtns[i].getAttribute("data-active") === "true" ||
        protoBtns[i].getAttribute("aria-pressed") === "true" ||
        protoBtns[i].classList.contains("is-active")
      ) {
        initialBtn = protoBtns[i];
        break;
      }
    }
    if (!initialBtn && protoBtns.length) {
      initialBtn = protoBtns[0];
    }
    selectProtocol(
      initialBtn ? initialBtn.getAttribute("data-tunnel-proto") : "rdp",
      initialBtn,
      false
    );
  }

  /* ------------------------------------------------------------------------
   * 6B. Live crypto.subtle RFC 6238 2FA Authenticator (#jala-live-totp)
   * ---------------------------------------------------------------------- */
  function initLiveTotpAuthenticator() {
    var root = document.getElementById("jala-live-totp");
    var codeEl = document.getElementById("jala-totp-code");
    var timerEl = document.getElementById("jala-totp-timer");
    var progressEl = document.getElementById("jala-totp-progress");
    var copyBtn = document.getElementById("jala-totp-copy");

    if (!root && !codeEl && !timerEl) return;

    var DEFAULT_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    var secretBase32 =
      (root && root.getAttribute("data-totp-secret")) ||
      (codeEl && codeEl.getAttribute("data-totp-secret")) ||
      DEFAULT_SECRET;
    var secretBytes = decodeBase32(secretBase32);
    var hmacKeyPromise = null;
    var counterBytes = new Uint8Array(8);
    var lastCounter = -1;
    var lastRemainingWhole = -1;
    var lastExpiring = null;
    var lastTransform = "";
    var currentRawToken = "482910";
    var copyResetTimer = 0;
    var intervalId = 0;

    if (progressEl) {
      progressEl.style.transformOrigin = "left center";
    }

    function getHmacKey() {
      if (hmacKeyPromise) return hmacKeyPromise;
      var subtle = window.crypto && window.crypto.subtle;
      if (!subtle) return Promise.resolve(null);
      hmacKeyPromise = subtle
        .importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
        .catch(function () {
          return null;
        });
      return hmacKeyPromise;
    }

    async function computeTotpForCounter(counter) {
      var subtle = window.crypto && window.crypto.subtle;
      var key = await getHmacKey();
      if (!subtle || !key) return null;

      var high = Math.floor(counter / 0x100000000);
      var low = counter >>> 0;
      counterBytes[0] = (high >>> 24) & 0xff;
      counterBytes[1] = (high >>> 16) & 0xff;
      counterBytes[2] = (high >>> 8) & 0xff;
      counterBytes[3] = high & 0xff;
      counterBytes[4] = (low >>> 24) & 0xff;
      counterBytes[5] = (low >>> 16) & 0xff;
      counterBytes[6] = (low >>> 8) & 0xff;
      counterBytes[7] = low & 0xff;

      var sigBuffer = await subtle.sign("HMAC", key, counterBytes);
      var digest = new Uint8Array(sigBuffer);
      var offset = digest[digest.length - 1] & 0x0f;
      var binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);

      return String(binary % 1000000).padStart(6, "0");
    }

    async function refreshTotp(forceWhileScrolling) {
      if (isActivelyScrolling && !forceWhileScrolling) return;

      var nowMs = Date.now();
      var periodSec = 30;
      var nowSec = nowMs / 1000;
      var counter = Math.floor(nowSec / periodSec);
      var elapsed = nowSec % periodSec;
      var remainingWhole = Math.max(1, Math.ceil(periodSec - elapsed));
      var ratio = clamp((periodSec - elapsed) / periodSec, 0, 1);

      if (timerEl && remainingWhole !== lastRemainingWhole) {
        lastRemainingWhole = remainingWhole;
        timerEl.textContent = remainingWhole + "s";
        var isExpiring = remainingWhole <= 5;
        if (isExpiring !== lastExpiring) {
          lastExpiring = isExpiring;
          if (isExpiring) {
            timerEl.setAttribute("data-expiring", "true");
          } else {
            timerEl.removeAttribute("data-expiring");
          }
        }
      }

      if (progressEl) {
        var nextTransform = "scaleX(" + ratio.toFixed(4) + ")";
        if (nextTransform !== lastTransform) {
          lastTransform = nextTransform;
          progressEl.style.transform = nextTransform;
        }
      }

      if (counter !== lastCounter) {
        lastCounter = counter;
        var token = await computeTotpForCounter(counter);
        if (token) {
          currentRawToken = token;
          var formatted = token.slice(0, 3) + " " + token.slice(3);
          if (codeEl) {
            codeEl.textContent = formatted;
            codeEl.setAttribute("data-totp-raw", token);
          }
          if (root) {
            root.setAttribute("data-totp-ready", "true");
          }
        }
      }
    }

    if (copyBtn) {
      var labelTarget =
        copyBtn.querySelector("[data-copy-label]") || copyBtn.querySelector("span") || copyBtn;
      var originalLabel = labelTarget.textContent;

      copyBtn.addEventListener("click", function () {
        var textToCopy = currentRawToken;
        if (codeEl && codeEl.getAttribute("data-totp-raw")) {
          textToCopy = codeEl.getAttribute("data-totp-raw");
        } else if (codeEl && codeEl.textContent) {
          textToCopy = codeEl.textContent.replace(/\s+/g, "");
        }

        function showCopiedState() {
          labelTarget.textContent = "Copied";
          copyBtn.setAttribute("data-copied", "true");
          copyBtn.classList.add("is-copied");
          if (copyResetTimer) window.clearTimeout(copyResetTimer);
          copyResetTimer = window.setTimeout(function () {
            labelTarget.textContent = originalLabel;
            copyBtn.removeAttribute("data-copied");
            copyBtn.classList.remove("is-copied");
          }, 1600);
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(textToCopy).then(showCopiedState, showCopiedState);
        } else {
          showCopiedState();
        }
      });
    }

    function startTicker() {
      if (intervalId) return;
      refreshTotp(true);
      intervalId = window.setInterval(function () {
        refreshTotp(false);
      }, 250);
    }

    function stopTicker() {
      if (!intervalId) return;
      window.clearInterval(intervalId);
      intervalId = 0;
    }

    onScrollActivityEnd(function () {
      if (!document.hidden) {
        refreshTotp(true);
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopTicker();
      } else {
        startTicker();
      }
    });

    startTicker();
  }

  /* ------------------------------------------------------------------------
   * 7. Scroll-Triggered Choreographed Entrance ([data-reveal])
   *    Observe-once · Zero getComputedStyle · Zero reverse-scroll toggling
   * ---------------------------------------------------------------------- */
  function initScrollReveal() {
    var root = document.documentElement;
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));

    if (!items.length) {
      root.classList.add("jala-kinetic-ready");
      return;
    }

    function revealImmediately(el) {
      el.style.removeProperty("--reveal-delay");
      el.classList.add("is-revealed");
    }

    if (reducedMotion.matches || typeof window.IntersectionObserver !== "function") {
      root.classList.add("jala-kinetic-ready");
      items.forEach(revealImmediately);
      return;
    }

    var viewportCutoff = (window.innerHeight || 900) * 0.94;
    var initialVisible = new Array(items.length);
    for (var r = 0; r < items.length; r += 1) {
      var rect = items[r].getBoundingClientRect();
      initialVisible[r] = rect.top < viewportCutoff && rect.bottom > 0;
    }

    root.classList.add("jala-kinetic-ready");

    var observer = new window.IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          if (entry.isIntersecting) {
            var el = entry.target;
            observer.unobserve(el);
            el.classList.add("is-revealed");
          }
        }
      },
      {
        threshold: 0.12,
        rootMargin: "0px 0px -24px 0px"
      }
    );

    for (var idx = 0; idx < items.length; idx += 1) {
      var item = items[idx];
      var rawDelay = parseInt(item.getAttribute("data-reveal-delay") || "0", 10);
      var delayMs = Number.isFinite(rawDelay) ? clamp(rawDelay, 0, 240) : 0;
      if (delayMs > 0) {
        item.style.setProperty("--reveal-delay", delayMs + "ms");
      }
      if (initialVisible[idx]) {
        item.classList.add("is-revealed");
      } else {
        observer.observe(item);
      }
    }

    reducedMotion.subscribe(function () {
      if (reducedMotion.matches) {
        observer.disconnect();
        items.forEach(revealImmediately);
      }
    });
  }

  /* ------------------------------------------------------------------------
   * Boot Orchestrator
   * ---------------------------------------------------------------------- */
  function bootKineticEngine() {
    initActiveScrollTracker();
    initScrollReveal();
    initScrollProgressLaser();
    var canvasState = initKineticConstellation();
    initHardwareStageTilt();
    initSpotlightCards();
    initLiveCipherPlayground();
    initBastionTunnelSimulator();
    initLiveTotpAuthenticator();

    window.JalaKineticEngine = {
      version: "1.17.0",
      reducedMotion: reducedMotion.matches,
      get isActivelyScrolling() {
        return isActivelyScrolling;
      },
      canvas: canvasState
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootKineticEngine);
  } else {
    bootKineticEngine();
  }
})();
