(function () {
  "use strict";

  function initProductStageTabs() {
    var tablist = document.querySelector('[role="tablist"][data-stage-tabs]');
    if (!tablist) return;

    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var metaLabel = document.getElementById("stage-active-meta");
    if (!tabs.length) return;

    function activateTab(nextTab, moveFocus) {
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

      if (metaLabel) {
        var spec = nextTab.getAttribute("data-stage-meta");
        if (spec) metaLabel.textContent = spec;
      }

      if (moveFocus) {
        nextTab.focus();
      }
    }

    tabs.forEach(function (tab, index) {
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
      var threshold = 140;
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initProductStageTabs();
      initLegalTocScrollSpy();
    });
  } else {
    initProductStageTabs();
    initLegalTocScrollSpy();
  }
})();
