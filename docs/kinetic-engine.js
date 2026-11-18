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
   * 1. Top Scroll-Progress Laser Bar (#jala-scroll-progress)
   * ---------------------------------------------------------------------- */
  function initScrollProgressLaser() {
    var bar = document.getElementById("jala-scroll-progress");
    var root = document.documentElement;
    var ticking = false;

    function computeAndApply() {
      ticking = false;
      var scrollTop = window.scrollY || root.scrollTop || 0;
      var maxScroll = Math.max(0, root.scrollHeight - window.innerHeight);
      var ratio = maxScroll > 0 ? clamp(scrollTop / maxScroll, 0, 1) : 0;
      var formatted = ratio.toFixed(4);

      root.style.setProperty("--scroll-ratio", formatted);
      if (bar) {
        bar.style.setProperty("--scroll-ratio", formatted);
        bar.style.transform = "scaleX(" + formatted + ")";
      }
    }

    function requestUpdate() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(computeAndApply);
      }
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate, { passive: true });
    computeAndApply();
  }

  /* ------------------------------------------------------------------------
   * 2. 60fps Canvas2D Zero-Trust Mesh & Encrypted Packet Constellation
   *    (canvas#jala-kinetic-canvas)
   * ---------------------------------------------------------------------- */
  function initKineticConstellation() {
    var canvas = document.getElementById("jala-kinetic-canvas");
    if (!canvas || typeof canvas.getContext !== "function") return null;

    var ctx = canvas.getContext("2d");
    if (!ctx) return null;

    var state = {
      width: 0,
      height: 0,
      dpr: 1,
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

    function seededUnit(seed) {
      var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
      return x - Math.floor(x);
    }

    function buildRoutePoints(a, b, mode, bendSign) {
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      if (mode === 0 || Math.abs(dx) < 36 || Math.abs(dy) < 24) {
        return [
          { x: a.x, y: a.y },
          { x: b.x, y: b.y }
        ];
      }
      var chamfer = Math.min(Math.abs(dx) * 0.34, Math.abs(dy) * 0.65, 44);
      var midX = a.x + dx * (bendSign > 0 ? 0.54 : 0.46);
      var dirX = dx >= 0 ? 1 : -1;
      var dirY = dy >= 0 ? 1 : -1;

      return [
        { x: a.x, y: a.y },
        { x: midX - dirX * chamfer * 0.5, y: a.y },
        { x: midX + dirX * chamfer * 0.5, y: a.y + dirY * chamfer },
        { x: midX + dirX * chamfer * 0.5, y: b.y },
        { x: b.x, y: b.y }
      ];
    }

    function computeRouteMetrics(points) {
      var segments = [];
      var total = 0;
      for (var i = 0; i < points.length - 1; i += 1) {
        var p0 = points[i];
        var p1 = points[i + 1];
        var len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if (len > 0.01) {
          segments.push({ p0: p0, p1: p1, len: len, start: total });
          total += len;
        }
      }
      return { segments: segments, totalLength: Math.max(1, total) };
    }

    function sampleRoute(route, progress) {
      var targetDist = clamp(progress, 0, 1) * route.totalLength;
      var segs = route.segments;
      if (!segs.length) return { x: 0, y: 0 };

      for (var i = 0; i < segs.length; i += 1) {
        var seg = segs[i];
        if (targetDist <= seg.start + seg.len || i === segs.length - 1) {
          var localT = clamp((targetDist - seg.start) / seg.len, 0, 1);
          return {
            x: seg.p0.x + (seg.p1.x - seg.p0.x) * localT,
            y: seg.p0.y + (seg.p1.y - seg.p0.y) * localT
          };
        }
      }
      var last = segs[segs.length - 1].p1;
      return { x: last.x, y: last.y };
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

          nodes.push({
            id: idx - 1,
            col: c,
            row: r,
            baseX: clamp(baseX, 24, w - 24),
            baseY: clamp(baseY, 24, h - 24),
            x: clamp(baseX, 24, w - 24),
            y: clamp(baseY, 24, h - 24),
            role: role,
            radius: role === "bastion" ? 3.5 : role === "vault" ? 3.8 : 2.5,
            phase: seededUnit(idx * 5.43) * Math.PI * 2,
            driftAmp: 2.2 + seededUnit(idx * 9.13) * 3.6,
            driftSpeed: 0.45 + seededUnit(idx * 2.71) * 0.55
          });
        }
      }

      var links = [];
      var linkSet = {};

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
          goldAccent: nodes[i].role === "vault" || nodes[j].role === "vault" || styleSeed > 0.78
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
        packets.push({
          linkIndex: linkIndex,
          t: seededUnit((p + 1) * 19.31),
          speed: 0.14 + seededUnit((p + 1) * 8.17) * 0.16,
          palette: isGold ? "gold" : p % 4 === 0 ? "emerald" : "sapphire"
        });
      }

      state.nodes = nodes;
      state.links = links;
      state.packets = packets;
    }

    function syncCanvasSize() {
      var rect = canvas.getBoundingClientRect();
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
      if (w <= 0 || h <= 0 || !state.nodes.length) return;

      ctx.clearRect(0, 0, w, h);

      var ptr = state.pointer;
      if (isStaticFrame) {
        ptr.energy = 0;
      } else {
        ptr.x = lerp(ptr.x, ptr.targetX, 0.12);
        ptr.y = lerp(ptr.y, ptr.targetY, 0.12);
        ptr.energy = lerp(ptr.energy, ptr.active ? 1 : 0, 0.08);
      }

      var proximityRadius = Math.min(260, Math.max(180, w * 0.18));
      var nodes = state.nodes;

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

      var linkRoutes = new Array(state.links.length);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (var l = 0; l < state.links.length; l += 1) {
        var link = state.links[l];
        var a = nodes[link.source];
        var b = nodes[link.target];
        var pts = buildRoutePoints(a, b, link.mode, link.bendSign);
        var route = computeRouteMetrics(pts);
        linkRoutes[l] = route;

        var edgeBoost = Math.max(a.boost || 0, b.boost || 0);
        var baseAlpha = link.goldAccent ? 0.13 : 0.11;
        var alpha = clamp(baseAlpha + edgeBoost * 0.28, 0.08, 0.46);

        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var pIdx = 1; pIdx < pts.length; pIdx += 1) {
          ctx.lineTo(pts[pIdx].x, pts[pIdx].y);
        }

        ctx.lineWidth = edgeBoost > 0.2 ? 1.25 : 1;
        ctx.strokeStyle = link.goldAccent
          ? "rgba(243, 198, 111, " + alpha.toFixed(3) + ")"
          : "rgba(56, 189, 248, " + alpha.toFixed(3) + ")";
        ctx.stroke();
      }

      for (var pk = 0; pk < state.packets.length; pk += 1) {
        var packet = state.packets[pk];
        var pRoute = linkRoutes[packet.linkIndex];
        if (!pRoute) continue;

        if (!isStaticFrame) {
          packet.t = (packet.t + dtSec * packet.speed) % 1;
        }

        var headPos = sampleRoute(pRoute, packet.t);
        var tailPos = sampleRoute(pRoute, Math.max(0, packet.t - 0.085));

        var tailGrad = ctx.createLinearGradient(tailPos.x, tailPos.y, headPos.x, headPos.y);
        if (packet.palette === "gold") {
          tailGrad.addColorStop(0, "rgba(243, 198, 111, 0)");
          tailGrad.addColorStop(1, "rgba(243, 198, 111, 0.88)");
        } else if (packet.palette === "emerald") {
          tailGrad.addColorStop(0, "rgba(110, 231, 183, 0)");
          tailGrad.addColorStop(1, "rgba(110, 231, 183, 0.84)");
        } else {
          tailGrad.addColorStop(0, "rgba(56, 189, 248, 0)");
          tailGrad.addColorStop(1, "rgba(56, 189, 248, 0.9)");
        }

        ctx.beginPath();
        ctx.moveTo(tailPos.x, tailPos.y);
        ctx.lineTo(headPos.x, headPos.y);
        ctx.lineWidth = 1.85;
        ctx.strokeStyle = tailGrad;
        ctx.stroke();

        var glowRadius = packet.palette === "gold" ? 7.5 : 6.5;
        var pktGlow = ctx.createRadialGradient(
          headPos.x,
          headPos.y,
          0,
          headPos.x,
          headPos.y,
          glowRadius
        );
        if (packet.palette === "gold") {
          pktGlow.addColorStop(0, "rgba(255, 244, 214, 0.95)");
          pktGlow.addColorStop(0.4, "rgba(243, 198, 111, 0.45)");
          pktGlow.addColorStop(1, "rgba(243, 198, 111, 0)");
        } else {
          pktGlow.addColorStop(0, "rgba(242, 248, 255, 0.95)");
          pktGlow.addColorStop(0.4, "rgba(56, 189, 248, 0.45)");
          pktGlow.addColorStop(1, "rgba(37, 99, 235, 0)");
        }

        ctx.fillStyle = pktGlow;
        ctx.beginPath();
        ctx.arc(headPos.x, headPos.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (ptr.energy > 0.03 && !isStaticFrame) {
        var fieldGrad = ctx.createRadialGradient(ptr.x, ptr.y, 0, ptr.x, ptr.y, proximityRadius * 0.72);
        fieldGrad.addColorStop(0, "rgba(56, 189, 248, " + (0.09 * ptr.energy).toFixed(3) + ")");
        fieldGrad.addColorStop(0.55, "rgba(37, 99, 235, " + (0.04 * ptr.energy).toFixed(3) + ")");
        fieldGrad.addColorStop(1, "rgba(5, 8, 15, 0)");
        ctx.fillStyle = fieldGrad;
        ctx.beginPath();
        ctx.arc(ptr.x, ptr.y, proximityRadius * 0.72, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.setLineDash([4, 4]);
        var connected = 0;
        for (var v = 0; v < nodes.length && connected < 4; v += 1) {
          var targetNode = nodes[v];
          if ((targetNode.boost || 0) <= 0.16) continue;
          connected += 1;
          var vecAlpha = clamp(targetNode.boost * 0.55, 0.06, 0.45);
          ctx.beginPath();
          ctx.moveTo(ptr.x, ptr.y);
          ctx.lineTo(targetNode.x, targetNode.y);
          ctx.lineWidth = 1;
          ctx.strokeStyle =
            targetNode.role === "vault" || targetNode.role === "bastion"
              ? "rgba(243, 198, 111, " + vecAlpha.toFixed(3) + ")"
              : "rgba(56, 189, 248, " + vecAlpha.toFixed(3) + ")";
          ctx.stroke();
        }
        ctx.restore();
      }

      for (var n = 0; n < nodes.length; n += 1) {
        var nd = nodes[n];
        var pulse = isStaticFrame ? 0.5 : 0.5 + 0.5 * Math.sin(timeSec * 1.9 + nd.phase);
        var haloR = nd.radius * (3.4 + pulse * 0.9 + (nd.boost || 0) * 2.2);
        var isWarm = nd.role === "vault" || nd.role === "bastion";

        var halo = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, haloR);
        if (isWarm) {
          halo.addColorStop(0, "rgba(243, 198, 111, " + (0.34 + (nd.boost || 0) * 0.3).toFixed(3) + ")");
          halo.addColorStop(0.55, "rgba(37, 99, 235, 0.12)");
          halo.addColorStop(1, "rgba(37, 99, 235, 0)");
        } else {
          halo.addColorStop(0, "rgba(56, 189, 248, " + (0.32 + (nd.boost || 0) * 0.32).toFixed(3) + ")");
          halo.addColorStop(0.6, "rgba(37, 99, 235, 0.11)");
          halo.addColorStop(1, "rgba(37, 99, 235, 0)");
        }
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, haloR, 0, Math.PI * 2);
        ctx.fill();

        if (nd.role === "bastion" || nd.role === "vault") {
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nd.radius + 3.2 + (nd.boost || 0) * 1.8, 0, Math.PI * 2);
          ctx.lineWidth = 0.9;
          ctx.strokeStyle =
            nd.role === "vault"
              ? "rgba(243, 198, 111, " + (0.36 + (nd.boost || 0) * 0.35).toFixed(3) + ")"
              : "rgba(56, 189, 248, " + (0.34 + (nd.boost || 0) * 0.35).toFixed(3) + ")";
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius, 0, Math.PI * 2);
        ctx.fillStyle =
          nd.role === "vault"
            ? "#F3C66F"
            : nd.role === "enclave"
              ? "#6EE7B7"
              : nd.role === "bastion"
                ? "#BAE6FD"
                : "#38BDF8";
        ctx.fill();
      }

      state.frameCount += 1;
      canvas.__jalaKineticState = {
        width: state.width,
        height: state.height,
        dpr: state.dpr,
        nodesCount: state.nodes.length,
        linksCount: state.links.length,
        packetsCount: state.packets.length,
        frameCount: state.frameCount,
        running: state.running,
        reducedMotion: reducedMotion.matches
      };
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

      if (reducedMotion.matches && state.width > 0) {
        renderFrame(0, 0, true);
      } else if (canvas.__jalaKineticState) {
        canvas.__jalaKineticState.running = state.running;
        canvas.__jalaKineticState.reducedMotion = reducedMotion.matches;
      }
    }

    if (!coarsePointer.matches) {
      window.addEventListener(
        "pointermove",
        function (event) {
          if (reducedMotion.matches || !state.inViewport) return;
          var rect = canvas.getBoundingClientRect();
          var inside =
            event.clientX >= rect.left - 40 &&
            event.clientX <= rect.right + 40 &&
            event.clientY >= rect.top - 40 &&
            event.clientY <= rect.bottom + 40;

          if (inside) {
            state.pointer.targetX = event.clientX - rect.left;
            state.pointer.targetY = event.clientY - rect.top;
            if (!state.pointer.active) {
              state.pointer.x = state.pointer.targetX;
              state.pointer.y = state.pointer.targetY;
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
        { threshold: 0.01 }
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

    var MAX_TILT_DEG = 3.8;
    var LERP_FACTOR = 0.085;

    stages.forEach(function (stage) {
      var parallaxItems = Array.prototype.slice.call(
        stage.querySelectorAll("[data-parallax-depth]")
      );
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

      function applyStageVars(rx, ry, gx, gy, glareAlpha) {
        stage.style.setProperty("--tilt-rx", rx.toFixed(3) + "deg");
        stage.style.setProperty("--tilt-ry", ry.toFixed(3) + "deg");
        stage.style.setProperty("--glare-x", gx.toFixed(2) + "%");
        stage.style.setProperty("--glare-y", gy.toFixed(2) + "%");
        stage.style.setProperty("--glare-alpha", glareAlpha.toFixed(3));

        var normX = MAX_TILT_DEG > 0 ? ry / MAX_TILT_DEG : 0;
        var normY = MAX_TILT_DEG > 0 ? -rx / MAX_TILT_DEG : 0;

        for (var i = 0; i < parallaxItems.length; i += 1) {
          var item = parallaxItems[i];
          var depth = parseFloat(item.getAttribute("data-parallax-depth")) || 14;
          var shiftX = normX * (depth * 0.42);
          var shiftY = normY * (depth * 0.42);
          item.style.setProperty("--parallax-x", shiftX.toFixed(2) + "px");
          item.style.setProperty("--parallax-y", shiftY.toFixed(2) + "px");
          if (Math.abs(shiftX) < 0.05 && Math.abs(shiftY) < 0.05) {
            item.style.translate = "";
          } else {
            item.style.translate = shiftX.toFixed(2) + "px " + shiftY.toFixed(2) + "px";
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

        currentRx = lerp(currentRx, targetRx, LERP_FACTOR);
        currentRy = lerp(currentRy, targetRy, LERP_FACTOR);
        currentGx = lerp(currentGx, targetGx, LERP_FACTOR * 1.35);
        currentGy = lerp(currentGy, targetGy, LERP_FACTOR * 1.35);
        currentAlpha = lerp(currentAlpha, targetAlpha, LERP_FACTOR * 1.2);

        applyStageVars(currentRx, currentRy, currentGx, currentGy, currentAlpha);

        var settled =
          !hovering &&
          Math.abs(currentRx - targetRx) < 0.004 &&
          Math.abs(currentRy - targetRy) < 0.004 &&
          Math.abs(currentAlpha - targetAlpha) < 0.004;

        if (!settled) {
          rafId = window.requestAnimationFrame(step);
        } else {
          applyStageVars(0, 0, 50, 50, 0);
        }
      }

      function ensureAnimating() {
        if (!rafId) {
          rafId = window.requestAnimationFrame(step);
        }
      }

      stage.addEventListener(
        "pointermove",
        function (event) {
          if (reducedMotion.matches || coarsePointer.matches || event.pointerType === "touch") {
            return;
          }
          var rect = stage.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;

          var relX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
          var relY = clamp((event.clientY - rect.top) / rect.height, 0, 1);

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

      stage.addEventListener("pointerleave", function () {
        hovering = false;
        targetRx = 0;
        targetRy = 0;
        targetGx = 50;
        targetGy = 50;
        targetAlpha = 0;
        stage.removeAttribute("data-tilt-active");
        ensureAnimating();
      });

      applyStageVars(0, 0, 50, 50, 0);
    });
  }

  /* ------------------------------------------------------------------------
   * 4. Cursor-Tracking Specular Spotlight Cards ([data-spotlight-card])
   * ---------------------------------------------------------------------- */
  function initSpotlightCards() {
    var cards = Array.prototype.slice.call(document.querySelectorAll("[data-spotlight-card]"));
    if (!cards.length) return;

    var pendingEvent = null;
    var rafId = 0;
    var activeCard = null;

    for (var i = 0; i < cards.length; i += 1) {
      cards[i].style.setProperty("--spot-alpha", "0");
    }

    function flushPointer() {
      rafId = 0;
      var ev = pendingEvent;
      if (!ev) return;

      var nextCard =
        ev.target && typeof ev.target.closest === "function"
          ? ev.target.closest("[data-spotlight-card]")
          : null;

      if (activeCard && activeCard !== nextCard) {
        activeCard.style.setProperty("--spot-alpha", "0");
        activeCard.removeAttribute("data-spot-active");
      }

      activeCard = nextCard;
      if (activeCard) {
        var rect = activeCard.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        var y = ev.clientY - rect.top;
        activeCard.style.setProperty("--spot-x", x.toFixed(1) + "px");
        activeCard.style.setProperty("--spot-y", y.toFixed(1) + "px");
        activeCard.style.setProperty("--spot-alpha", "1");
        activeCard.setAttribute("data-spot-active", "true");
      }
    }

    document.addEventListener(
      "pointermove",
      function (event) {
        if (event.pointerType === "touch") return;
        pendingEvent = event;
        if (!rafId) {
          rafId = window.requestAnimationFrame(flushPointer);
        }
      },
      { passive: true }
    );

    document.addEventListener("pointerleave", function () {
      if (activeCard) {
        activeCard.style.setProperty("--spot-alpha", "0");
        activeCard.removeAttribute("data-spot-active");
        activeCard = null;
      }
    });
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

    function animateBase64Decode(targetEl, cipherBytes, finalBase64) {
      if (!targetEl) return;
      if (scrambleRaf) {
        window.cancelAnimationFrame(scrambleRaf);
        scrambleRaf = 0;
      }

      targetEl.setAttribute("data-ciphertext", finalBase64);

      if (reducedMotion.matches || !cipherBytes || cipherBytes.length === 0) {
        targetEl.textContent = finalBase64;
        return;
      }

      var durationMs = 180;
      var startTs = performance.now();
      var noiseBytes = new Uint8Array(cipherBytes.length);
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        window.crypto.getRandomValues(noiseBytes);
      }

      var initialBlend = new Uint8Array(cipherBytes.length);
      for (var i = 0; i < cipherBytes.length; i += 1) {
        initialBlend[i] = i < 2 ? cipherBytes[i] : noiseBytes[i];
      }
      targetEl.textContent = bytesToBase64(initialBlend);

      function stepScramble(now) {
        var progress = clamp((now - startTs) / durationMs, 0, 1);
        if (progress >= 1) {
          scrambleRaf = 0;
          targetEl.textContent = finalBase64;
          return;
        }

        var lockedBytes = Math.floor(progress * cipherBytes.length);
        var frameBytes = new Uint8Array(cipherBytes.length);
        for (var b = 0; b < cipherBytes.length; b += 1) {
          if (b < lockedBytes) {
            frameBytes[b] = cipherBytes[b];
          } else {
            frameBytes[b] = (noiseBytes[b] + Math.floor(progress * 97) + b * 13) & 0xff;
          }
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
      var modeSpec = KEY_MATERIAL_BY_MODE[activeMode] || KEY_MATERIAL_BY_MODE.account;
      var subtle = window.crypto && window.crypto.subtle;

      if (!subtle || typeof window.crypto.getRandomValues !== "function") {
        if (metaEl) {
          metaEl.textContent = "Web Crypto API requires HTTPS or localhost Secure Context";
        }
        return;
      }

      try {
        var salt = new Uint8Array(16);
        var iv = new Uint8Array(12);
        window.crypto.getRandomValues(salt);
        window.crypto.getRandomValues(iv);

        var iterations = calibratedIterations || 100000;
        var t0 = performance.now();

        var baseKey = await subtle.importKey(
          "raw",
          encoder.encode(modeSpec.secret),
          { name: "PBKDF2" },
          false,
          ["deriveKey"]
        );

        var aesKey = await subtle.deriveKey(
          {
            name: "PBKDF2",
            salt: salt,
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
            iv: iv,
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
        var tagBytes = sealedBytes.slice(tagStart);
        var bodyBytes = sealedBytes.length > 16 ? sealedBytes.slice(0, tagStart) : sealedBytes;
        var finalBase64 = bytesToBase64(bodyBytes);

        if (saltEl) saltEl.textContent = bytesToHex(salt);
        if (ivEl) ivEl.textContent = bytesToHex(iv);
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
        void root.offsetWidth;
        root.classList.add("is-bursting");
      }
      if (svgEl) {
        svgEl.classList.remove("is-bursting");
        svgEl.classList.add("is-bursting");
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
    var lastCounter = -1;
    var currentRawToken = "482910";
    var copyResetTimer = 0;
    var intervalId = 0;

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

      var counterBytes = new Uint8Array(8);
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

    async function refreshTotp() {
      var nowMs = Date.now();
      var periodSec = 30;
      var nowSec = nowMs / 1000;
      var counter = Math.floor(nowSec / periodSec);
      var elapsed = nowSec % periodSec;
      var remainingWhole = Math.max(1, Math.ceil(periodSec - elapsed));
      var ratio = clamp((periodSec - elapsed) / periodSec, 0, 1);

      if (timerEl) {
        timerEl.textContent = remainingWhole + "s";
        if (remainingWhole <= 5) {
          timerEl.setAttribute("data-expiring", "true");
        } else {
          timerEl.removeAttribute("data-expiring");
        }
      }

      if (progressEl) {
        var ratioStr = ratio.toFixed(4);
        progressEl.style.setProperty("--totp-ratio", ratioStr);
        progressEl.style.transformOrigin = "left center";
        progressEl.style.transform = "scaleX(" + ratioStr + ")";
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
      refreshTotp();
      intervalId = window.setInterval(refreshTotp, 250);
    }

    function stopTicker() {
      if (!intervalId) return;
      window.clearInterval(intervalId);
      intervalId = 0;
    }

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
   * ---------------------------------------------------------------------- */
  function initScrollReveal() {
    var root = document.documentElement;
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
    root.classList.add("jala-kinetic-ready");

    if (!items.length) return;

    function revealImmediately(el) {
      el.style.removeProperty("--reveal-delay");
      el.classList.add("is-revealed");
    }

    if (reducedMotion.matches || typeof window.IntersectionObserver !== "function") {
      items.forEach(revealImmediately);
      return;
    }

    function revealWithOptionalDelay(el) {
      var rawDelay = parseInt(el.getAttribute("data-reveal-delay") || "0", 10);
      var delayMs = Number.isFinite(rawDelay) ? clamp(rawDelay, 0, 240) : 0;

      if (delayMs > 0) {
        el.style.setProperty("--reveal-delay", delayMs + "ms");
        var computedDelay = parseFloat(window.getComputedStyle(el).transitionDelay || "0") || 0;
        if (computedDelay > 0) {
          el.classList.add("is-revealed");
        } else {
          window.setTimeout(function () {
            el.classList.add("is-revealed");
          }, delayMs);
        }
      } else {
        el.classList.add("is-revealed");
      }
    }

    var observer = new window.IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            revealWithOptionalDelay(entry.target);
          }
        }
      },
      {
        threshold: 0.12,
        rootMargin: "0px 0px -24px 0px"
      }
    );

    var viewportCutoff = (window.innerHeight || 900) * 0.94;
    items.forEach(function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.top < viewportCutoff && rect.bottom > 0) {
        revealWithOptionalDelay(el);
      } else {
        observer.observe(el);
      }
    });

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
    initScrollReveal();
    initScrollProgressLaser();
    var canvasState = initKineticConstellation();
    initHardwareStageTilt();
    initSpotlightCards();
    initLiveCipherPlayground();
    initBastionTunnelSimulator();
    initLiveTotpAuthenticator();

    window.JalaKineticEngine = {
      version: "1.16.0",
      reducedMotion: reducedMotion.matches,
      canvas: canvasState
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootKineticEngine);
  } else {
    bootKineticEngine();
  }
})();
