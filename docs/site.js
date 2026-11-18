(function () {
  "use strict";

  function initProductStageTabs() {
    var tablist = document.querySelector('[role="tablist"][data-stage-tabs]');
    if (!tablist) return;

    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var glider = tablist.querySelector("[data-tab-glider]");
    var metaLabel = document.getElementById("stage-active-meta");
    var statusEngine = document.getElementById("stage-status-engine");
    var statusCipher = document.getElementById("stage-status-cipher");
    var statusScope = document.getElementById("stage-status-scope");
    var hudLayer = document.querySelector(".stage-hud-layer");
    if (!tabs.length) return;

    var activeTabRef = tabs[0];

    function syncGlider(targetTab) {
      if (!glider || !targetTab) return;
      var x = targetTab.offsetLeft;
      var y = targetTab.offsetTop;
      var w = targetTab.offsetWidth;
      var h = targetTab.offsetHeight;
      if (w <= 0 || h <= 0) return;

      tablist.style.setProperty("--glider-x", x + "px");
      tablist.style.setProperty("--glider-y", y + "px");
      tablist.style.setProperty("--glider-w", w + "px");
      tablist.style.setProperty("--glider-h", h + "px");
      tablist.setAttribute("data-glider-ready", "true");
    }

    function activateTab(nextTab, moveFocus) {
      activeTabRef = nextTab;

      tabs.forEach(function (tab) {
        var isSelected = tab === nextTab;
        var panelId = tab.getAttribute("aria-controls");
        var panel = panelId ? document.getElementById(panelId) : null;

        tab.setAttribute("aria-selected", isSelected ? "true" : "false");
        tab.setAttribute("tabindex", isSelected ? "0" : "-1");

        if (panel) {
          if (isSelected) {
            panel.removeAttribute("hidden");
          } else {
            panel.setAttribute("hidden", "");
          }
        }
      });

      if (hudLayer) {
        var isDesktopPanel = nextTab.getAttribute("aria-controls") === "panel-desktop";
        hudLayer.setAttribute("data-hud-mode", isDesktopPanel ? "desktop" : "compact");
      }

      if (metaLabel) {
        var spec = nextTab.getAttribute("data-stage-meta");
        if (spec) metaLabel.textContent = spec;
      }
      if (statusEngine) {
        var eng = nextTab.getAttribute("data-stage-engine");
        if (eng) statusEngine.textContent = eng;
      }
      if (statusCipher) {
        var cip = nextTab.getAttribute("data-stage-cipher");
        if (cip) statusCipher.textContent = cip;
      }
      if (statusScope) {
        var scp = nextTab.getAttribute("data-stage-scope");
        if (scp) statusScope.textContent = scp;
      }

      syncGlider(nextTab);

      if (moveFocus) {
        nextTab.focus();
      }
    }

    tabs.forEach(function (tab, index) {
      if (tab.getAttribute("aria-selected") === "true") {
        activeTabRef = tab;
      }

      tab.addEventListener("click", function () {
        activateTab(tab, false);
      });

      tab.addEventListener("keydown", function (event) {
        var targetIndex = -1;
        if (event.key === "ArrowRight") {
          targetIndex = (index + 1) % tabs.length;
        } else if (event.key === "ArrowLeft") {
          targetIndex = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          targetIndex = 0;
        } else if (event.key === "End") {
          targetIndex = tabs.length - 1;
        }

        if (targetIndex !== -1) {
          event.preventDefault();
          activateTab(tabs[targetIndex], true);
        }
      });
    });

    window.requestAnimationFrame(function () {
      syncGlider(activeTabRef);
    });

    if (typeof window.ResizeObserver === "function") {
      var ro = new window.ResizeObserver(function () {
        syncGlider(activeTabRef);
      });
      ro.observe(tablist);
    } else {
      window.addEventListener(
        "resize",
        function () {
          syncGlider(activeTabRef);
        },
        { passive: true }
      );
    }
  }

  function initBlueprintInspector() {
    var chips = Array.prototype.slice.call(document.querySelectorAll("[data-blueprint-chip]"));
    var caption = document.getElementById("blueprint-caption-text");
    var frame = document.querySelector(".blueprint-frame");
    if (!chips.length || !caption) return;

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (item) {
          item.setAttribute("aria-pressed", item === chip ? "true" : "false");
        });
        var detail = chip.getAttribute("data-blueprint-detail");
        if (detail) {
          caption.textContent = detail;
        }
        if (frame) {
          var layer = chip.getAttribute("data-blueprint-layer") || "all";
          frame.setAttribute("data-active-layer", layer);
        }
      });
    });
  }

  function isReducedMotionPreferred() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function initSmoothAnchorLinks() {
    document.addEventListener("click", function (event) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      var origin = event.target;
      var link =
        origin && typeof origin.closest === "function" ? origin.closest('a[href^="#"]') : null;
      if (!link) return;

      var href = link.getAttribute("href") || "";
      if (href.length <= 1) return;

      var targetId = "";
      try {
        targetId = decodeURIComponent(href.slice(1));
      } catch (_err) {
        targetId = href.slice(1);
      }
      if (!targetId) return;

      var target = document.getElementById(targetId);
      if (!target) return;

      event.preventDefault();
      target.scrollIntoView({
        behavior: isReducedMotionPreferred() ? "auto" : "smooth",
        block: "start"
      });

      if (window.history && typeof window.history.pushState === "function") {
        try {
          window.history.pushState(null, "", "#" + targetId);
        } catch (_err) {
          /* Ignore pushState restrictions on non-HTTP origins */
        }
      }

      if (link.classList.contains("skip-link") || targetId === "main-content") {
        if (!target.hasAttribute("tabindex")) {
          target.setAttribute("tabindex", "-1");
        }
        if (typeof target.focus === "function") {
          target.focus({ preventScroll: true });
        }
      }
    });
  }

  function initLegalTocScrollSpy() {
    var toc = document.querySelector(".legal-toc");
    if (!toc) return;

    var links = Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]'));
    if (!links.length) return;

    var sections = [];
    var indexById = Object.create(null);
    links.forEach(function (link) {
      var id = link.getAttribute("href").slice(1);
      var section = id ? document.getElementById(id) : null;
      if (section) {
        indexById[id] = sections.length;
        sections.push({ id: id, section: section, link: link });
      }
    });

    if (!sections.length) return;

    var currentActiveId = "";

    function setActive(activeId) {
      if (!activeId || activeId === currentActiveId) return;
      currentActiveId = activeId;
      for (var i = 0; i < sections.length; i += 1) {
        var item = sections[i];
        var active = item.id === activeId;
        item.link.classList.toggle("is-active", active);
        if (active) {
          item.link.setAttribute("aria-current", "location");
        } else {
          item.link.removeAttribute("aria-current");
        }
      }
    }

    links.forEach(function (link) {
      link.addEventListener("click", function () {
        var id = link.getAttribute("href").slice(1);
        if (id && Object.prototype.hasOwnProperty.call(indexById, id)) {
          setActive(id);
        }
      });
    });

    var initialHash = window.location.hash ? window.location.hash.slice(1) : "";
    if (initialHash && Object.prototype.hasOwnProperty.call(indexById, initialHash)) {
      setActive(initialHash);
    } else {
      setActive(sections[0].id);
    }

    if (typeof window.IntersectionObserver !== "function") {
      return;
    }

    var inActiveBand = Object.create(null);
    var footerVisible = false;
    var lastCandidateId = currentActiveId || sections[0].id;

    function resolveActiveSection() {
      if (footerVisible) {
        setActive(sections[sections.length - 1].id);
        return;
      }
      for (var i = 0; i < sections.length; i += 1) {
        if (inActiveBand[sections[i].id]) {
          lastCandidateId = sections[i].id;
          setActive(lastCandidateId);
          return;
        }
      }
      if (lastCandidateId) {
        setActive(lastCandidateId);
      }
    }

    var bandObserver = new window.IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          var id = entry.target.id;
          if (!Object.prototype.hasOwnProperty.call(indexById, id)) continue;

          inActiveBand[id] = entry.isIntersecting;
          if (entry.isIntersecting) {
            lastCandidateId = id;
          } else if (entry.boundingClientRect.top > 0) {
            var prevIdx = Math.max(0, indexById[id] - 1);
            lastCandidateId = sections[prevIdx].id;
          } else {
            lastCandidateId = id;
          }
        }
        resolveActiveSection();
      },
      {
        rootMargin: "-18% 0px -68% 0px",
        threshold: 0
      }
    );

    for (var s = 0; s < sections.length; s += 1) {
      bandObserver.observe(sections[s].section);
    }

    var bottomTarget =
      document.querySelector(".site-footer") || sections[sections.length - 1].section;
    var isFooterTarget = bottomTarget && bottomTarget.classList.contains("site-footer");

    if (bottomTarget) {
      var bottomObserver = new window.IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            footerVisible = entries[i].isIntersecting;
          }
          resolveActiveSection();
        },
        {
          rootMargin: isFooterTarget ? "0px 0px -8% 0px" : "-35% 0px 0px 0px",
          threshold: isFooterTarget ? 0.05 : 0.85
        }
      );
      bottomObserver.observe(bottomTarget);
    }
  }

  function boot() {
    initProductStageTabs();
    initBlueprintInspector();
    initSmoothAnchorLinks();
    initLegalTocScrollSpy();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
