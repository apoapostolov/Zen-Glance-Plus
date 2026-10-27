/**
 * Zen Glance Plus — Zen Browser mod
 * https://github.com/apoapostolov/Zen-Glance-Plus
 * License: MIT
 *
 * Every new tab a site asks for becomes a Glance, decided by the kind of tab it
 * was opened from: an essential, a pinned tab, an ordinary tab, or a New Tab
 * page.
 *
 * Stock Zen opens a Glance only for a gesture (a modifier click), for a
 * bookmark or search result with the modifier held, and automatically only for
 * links that leave an essential tab and cross a domain boundary.
 *
 * The seam is `gBrowser.addTab`: it is the one function every tab-opening path
 * in the browser window reaches, and it carries the address. The `TabOpen`
 * event does not, because it fires before the browser begins loading, when the
 * tab still holds about:blank.
 */

(() => {
  "use strict";

  const PREF_ROOT = "zen-glance-plus.";
  const PREF = {
    essential: PREF_ROOT + "essential",
    pinned: PREF_ROOT + "pinned",
    normal: PREF_ROOT + "normal",
    newtab: PREF_ROOT + "newtab",
    redirect: PREF_ROOT + "redirect",
  };

  const DEFAULTS = {
    essential: true,
    pinned: true,
    normal: false,
    newtab: true,
    redirect: false,
  };

  const GLANCEABLE_SCHEMES = ["http", "https", "file"];
  const NEW_TAB_URLS = ["about:newtab", "about:home", "about:blank"];

  /* ----------------------------------------------------------- preferences */

  function readPrefBool(name, fallback) {
    try {
      return Services.prefs.getBoolPref(name, fallback);
    } catch (e) {
      return fallback;
    }
  }

  function setting(name) {
    return readPrefBool(PREF[name], DEFAULTS[name]);
  }

  /* --------------------------------------------------------- tab kinds */

  /**
   * Which kind of tab a page was opened from.
   * Essentials are pinned as well, so they are tested first; a New Tab page is
   * an ordinary tab with its own marker, so it is tested before `normal`.
   */
  function sourceKind(tab) {
    if (!tab) {
      return "normal";
    }
    if (tab.hasAttribute?.("zen-essential")) {
      return "essential";
    }
    if (tab.pinned) {
      return "pinned";
    }
    if (tab.hasAttribute?.("zen-empty-tab")) {
      return "newtab";
    }
    const spec = tab.linkedBrowser?.currentURI?.spec;
    if (spec && NEW_TAB_URLS.some(url => spec === url || spec.startsWith(`${url}#`) || spec.startsWith(`${url}?`))) {
      return "newtab";
    }
    return "normal";
  }

  function shouldGlanceFrom(kind) {
    return Object.prototype.hasOwnProperty.call(DEFAULTS, kind) && setting(kind);
  }

  /* ---------------------------------------------------------------- the tab */

  const state = {
    originalAddTab: null,
    originalOpenLinkIn: null,
    originalOpenTrustedLinkIn: null,
    plan: null,
    lastParent: null,
    started: false,
  };

  function glanceManager() {
    return window.gZenGlanceManager ?? null;
  }

  function isGlanceOpen() {
    if (typeof document.querySelector !== "function") {
      return false;
    }
    return !!(
      gBrowser.selectedTab?.hasAttribute?.("glance-id") ||
      document.querySelector("#tabbrowser-tabpanels .zen-glance-overlay")
    );
  }

  function glanceableUrl(urlString) {
    try {
      const url = new URL(String(urlString));
      return GLANCEABLE_SCHEMES.includes(url.protocol.replace(":", ""))
        ? url.href
        : null;
    } catch (e) {
      return null;
    }
  }

  /** Where the Glance appears to grow out of. */
  function animationRect() {
    const last = glanceManager()?.lastLinkClickData;
    if (last && last.width > 0 && last.height > 0) {
      return {
        clientX: last.clientX,
        clientY: last.clientY,
        width: last.width,
        height: last.height,
      };
    }
    const box =
      gBrowser.tabbox?.getBoundingClientRect?.() ?? {
        width: window.innerWidth || 1,
        height: window.innerHeight || 1,
      };
    // A real height and width keep Zen from substituting its record of the
    // last click, which by now may belong to a different page.
    return {
      clientX: (box.width || 1) / 2,
      clientY: (box.height || 1) / 2,
      width: 1,
      height: 1,
    };
  }

  /**
   * The tab the new one was opened from. `addTab` runs before the new tab is
   * selected, so the current selection is still the page the user was on;
   * `lastParent` only covers a call made after the selection already moved.
   */
  function parentFor(params) {
    if (params?.ownerTab) {
      return params.ownerTab;
    }
    if (params?.openerBrowser) {
      const opened = gBrowser.getTabForBrowser?.(params.openerBrowser);
      if (opened) {
        return opened;
      }
    }
    return gBrowser.selectedTab ?? state.lastParent;
  }

  /**
   * Decide whether this addTab call should end up as a Glance.
   * Returns null when stock behaviour must stand.
   */
  function planFor(uriString, params) {
    if (!readPrefBool("zen.glance.enabled", true)) {
      return null;
    }
    if (!params || params.createLazyBrowser || params.skipLoad) {
      return null;
    }
    if (params.essential || params.pinned) {
      return null;
    }
    // "Open all in tabs" would otherwise turn a folder into a pile of Glances.
    if (params.bulkOrderedOpen) {
      return null;
    }
    const url = glanceableUrl(
      typeof uriString === "string" ? uriString : uriString?.spec
    );
    if (!url) {
      return null;
    }
    const parent = parentFor(params);
    if (!parent) {
      return null;
    }
    const kind = sourceKind(parent);
    if (!shouldGlanceFrom(kind)) {
      return null;
    }
    return { url, parent, kind };
  }

  function openGlanceOver(tab, plan) {
    const manager = glanceManager();
    if (!manager?.openGlance) {
      return;
    }
    if (!tab || tab.closing || tab.hasAttribute?.("zen-glance-tab")) {
      return;
    }
    if (manager._animating) {
      return;
    }
    if (isGlanceOpen()) {
      if (typeof manager.fullyOpenGlance !== "function") {
        return;
      }
      Promise.resolve(manager.fullyOpenGlance())
        .catch(() => {})
        .then(() => new Promise(resolve => setTimeout(resolve, 80)))
        .then(() => {
          if (!isGlanceOpen()) {
            adopt(tab, plan);
          }
        });
      return;
    }
    adopt(tab, plan);
  }

  /**
   * `url: undefined` with an existing tab reuses the tab that was opened, so
   * there is no second tab and no second load. This is the path Zen itself
   * takes for external links opened from an essential.
   */
  function adopt(tab, plan) {
    const manager = glanceManager();
    if (!manager?.openGlance || !tab?.isConnected || tab.closing) {
      return;
    }
    try {
      manager.openGlance(
        { url: undefined, ...animationRect() },
        tab,
        manager.getTabOrGlanceParent?.(plan.parent) ?? plan.parent
      );
    } catch (e) {
      console.error("[zen-glance-plus] could not open the Glance", e);
    }
  }

  function onTabOpen(event) {
    const tab = event.target;
    const plan = state.plan;
    if (!plan) {
      return;
    }
    // One plan settles one tab. TabOpen is dispatched inside addTab, so the
    // plan on the stack belongs to this tab and to no other.
    state.plan = null;
    if (tab.hasAttribute?.("pending") || tab.hasAttribute?.("zen-glance-tab")) {
      return;
    }
    // Let addTab finish its own work first: a tab moved into another tab's DOM
    // halfway through creation leaves the tab strip inconsistent.
    Promise.resolve().then(() => openGlanceOver(tab, plan));
  }

  function onTabSelect(event) {
    const tab = event.target;
    if (!tab?.hasAttribute?.("glance-id")) {
      state.lastParent = tab;
    }
  }

  /* ---------------------------------------------------- normal tab redirect */

  /**
   * A link that would replace the tab you are on. Only page-initiated opens
   * are taken, so typing in the address bar still navigates the tab.
   */
  function redirectPlan(urlString, where, params) {
    if (where !== "current" || !setting("redirect")) {
      return null;
    }
    const principal = params?.triggeringPrincipal;
    if (!principal || principal.isSystemPrincipal) {
      return null;
    }
    const parent = gBrowser.selectedTab;
    if (!parent || sourceKind(parent) !== "normal") {
      return null;
    }
    const url = glanceableUrl(urlString);
    if (!url) {
      return null;
    }
    return { url, parent, kind: "normal" };
  }

  function openGlanceInstead(plan) {
    const manager = glanceManager();
    if (!manager?.openGlance) {
      return false;
    }
    if (manager._animating || isGlanceOpen()) {
      return false;
    }
    try {
      manager.openGlance({
        url: plan.url,
        ...animationRect(),
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return true;
    } catch (e) {
      console.error("[zen-glance-plus] could not open the Glance", e);
      return false;
    }
  }

  /* -------------------------------------------------------------- install */

  function wrapAddTab() {
    const original = gBrowser.addTab;
    state.originalAddTab = original;
    gBrowser.addTab = function (uriString, params, ...rest) {
      let plan = null;
      try {
        plan = planFor(uriString, params);
      } catch (e) {
        plan = null;
      }
      const previous = state.plan;
      state.plan = plan;
      try {
        return original.call(gBrowser, uriString, params, ...rest);
      } finally {
        state.plan = previous;
      }
    };
  }

  function wrapOpenLinkIn(name) {
    const original = window[name];
    if (typeof original !== "function") {
      return;
    }
    state[name === "openLinkIn" ? "originalOpenLinkIn" : "originalOpenTrustedLinkIn"] = original;
    window[name] = function (url, where, params) {
      let plan = null;
      try {
        plan = redirectPlan(url, where, params);
      } catch (e) {
        plan = null;
      }
      if (plan && openGlanceInstead(plan)) {
        return undefined;
      }
      return original.apply(window, arguments);
    };
  }

  function start() {
    if (state.started || !window.gBrowser || typeof window.gBrowser.addTab !== "function") {
      return false;
    }
    state.started = true;
    state.lastParent = gBrowser.selectedTab?.hasAttribute?.("glance-id")
      ? null
      : gBrowser.selectedTab;
    wrapAddTab();
    wrapOpenLinkIn("openLinkIn");
    wrapOpenLinkIn("openTrustedLinkIn");
    gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen, true);
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect, true);
    window.addEventListener(
      "unload",
      () => {
        stop();
      },
      { once: true }
    );
    return true;
  }

  function stop() {
    if (!state.started) {
      return;
    }
    state.started = false;
    if (state.originalAddTab) {
      gBrowser.addTab = state.originalAddTab;
      state.originalAddTab = null;
    }
    if (state.originalOpenLinkIn) {
      window.openLinkIn = state.originalOpenLinkIn;
      state.originalOpenLinkIn = null;
    }
    if (state.originalOpenTrustedLinkIn) {
      window.openTrustedLinkIn = state.originalOpenTrustedLinkIn;
      state.originalOpenTrustedLinkIn = null;
    }
    gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen, true);
    gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect, true);
  }

  const api = {
    start,
    stop,
    sourceKind,
    planFor,
    redirectPlan,
    setting,
    state,
    PREF,
    DEFAULTS,
  };

  // Reachable from the Browser Toolbox, and from the test harness.
  window.__zenGlancePlus = api;
  try {
    if (!start()) {
      // The window is still building its tab browser; try again on load.
      window.addEventListener("load", () => start(), { once: true });
    }
  } catch (e) {
    console.error("[zen-glance-plus] could not start", e);
  }
})();
