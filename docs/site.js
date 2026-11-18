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

  function initLegalTocScrollSpy() {
    var toc = document.querySelector(".legal-toc");
    if (!toc) return;

    var links = Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]'));
    if (!links.length) return;

    var sections = [];
    links.forEach(function (link) {
      var id = link.getAttribute("href").slice(1);
      var section = id ? document.getElementById(id) : null;
      if (section) {
        sections.push({ id: id, section: section, link: link });
      }
    });

    if (!sections.length) return;

    function setActive(activeId) {
      sections.forEach(function (item) {
        var active = item.id === activeId;
        item.link.classList.toggle("is-active", active);
        if (active) {
          item.link.setAttribute("aria-current", "location");
        } else {
          item.link.removeAttribute("aria-current");
        }
      });
    }

    function updateOnScroll() {
      var threshold = 150;
      var currentId = sections[0].id;
      for (var i = 0; i < sections.length; i += 1) {
        var rect = sections[i].section.getBoundingClientRect();
        if (rect.top <= threshold) {
          currentId = sections[i].id;
        }
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24) {
        currentId = sections[sections.length - 1].id;
      }
      setActive(currentId);
    }

    var ticking = false;
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          window.requestAnimationFrame(function () {
            updateOnScroll();
            ticking = false;
          });
          ticking = true;
        }
      },
      { passive: true }
    );

    links.forEach(function (link) {
      link.addEventListener("click", function () {
        var id = link.getAttribute("href").slice(1);
        if (id) setActive(id);
      });
    });

    updateOnScroll();
  }

  function boot() {
    initProductStageTabs();
    initBlueprintInspector();
    initLegalTocScrollSpy();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
