// ==UserScript==
// @name         D&D Beyond API Interceptor & DOM Clipboard Exporter
// @namespace    https://github.com/custom-dnd-tools
// @version      4.1.0
// @description  Ctrl+Shift+C copies intercepted character-service JSON responses; Ctrl+Alt+C copies document.body.outerHTML.
// @match        https://www.dndbeyond.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const TARGET_HOST = "character-service.dndbeyond.com";
  const CHARACTER_PATH_REGEX = /\/characters\/(\d+)(?:\/|$)/;
  const capturedResponses = new Map();
  let isCopyingDom = false;

  console.info("[DDB Exporter] Userscript initialized");

  function isCharacterSheetPage() {
    return CHARACTER_PATH_REGEX.test(window.location.pathname);
  }

  /**
   * Store parsed JSON payload keyed by endpoint URL
   */
  function recordResponse(url, transport, status, rawBody) {
    try {
      const parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      capturedResponses.set(url, {
        capturedAt: new Date().toISOString(),
        transport,
        status,
        url,
        payload: parsed
      });
      console.info(`[DDB Exporter] Captured (${capturedResponses.size}): ${url}`);
    } catch (_) {
      // Ignore non-JSON responses (e.g., preflight OPTIONS or empty 204)
    }
  }

  /**
   * Patch pageWindow.fetch in the page's main world
   */
  if (typeof pageWindow.fetch === "function") {
    const originalFetch = pageWindow.fetch.bind(pageWindow);
    pageWindow.fetch = async function (...args) {
      const response = await originalFetch(...args);

      try {
        const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (requestUrl.includes(TARGET_HOST)) {
          const cloned = response.clone();
          cloned
            .text()
            .then((text) => {
              recordResponse(requestUrl, "fetch", response.status, text);
            })
            .catch(() => {});
        }
      } catch (_) {
        // Never interfere with native fetch execution
      }

      return response;
    };
  }

  /**
   * Patch pageWindow.XMLHttpRequest in case any client module uses XHR
   */
  if (pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype) {
    const xhrProto = pageWindow.XMLHttpRequest.prototype;
    const originalXhrOpen = xhrProto.open;
    const originalXhrSend = xhrProto.send;

    xhrProto.open = function (method, url, ...rest) {
      this._ddbInterceptedUrl = typeof url === "string" ? url : String(url || "");
      return originalXhrOpen.apply(this, [method, url, ...rest]);
    };

    xhrProto.send = function (...args) {
      if (this._ddbInterceptedUrl && this._ddbInterceptedUrl.includes(TARGET_HOST)) {
        this.addEventListener("load", function () {
          if (this.responseType === "" || this.responseType === "text") {
            recordResponse(this._ddbInterceptedUrl, "xhr", this.status, this.responseText);
          } else if (this.responseType === "json" && this.response) {
            recordResponse(this._ddbInterceptedUrl, "xhr", this.status, this.response);
          }
        });
      }
      return originalXhrSend.apply(this, args);
    };
  }

  /**
   * Display a lightweight status toast in the bottom-right corner
   */
  function showToast(message, type = "info") {
    if (!document.body) return;

    let toast = document.getElementById("ddb-combined-exporter-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ddb-combined-exporter-toast";
      Object.assign(toast.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "999999",
        padding: "12px 16px",
        borderRadius: "6px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "13px",
        fontWeight: "600",
        color: "#ffffff",
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
        transition: "opacity 0.2s ease",
        pointerEvents: "none"
      });
      document.body.appendChild(toast);
    }

    const backgrounds = {
      info: "#1e293b",
      success: "#15803d",
      error: "#b91c1c"
    };

    toast.style.backgroundColor = backgrounds[type] || backgrounds.info;
    toast.style.opacity = "1";
    toast.textContent = message;

    clearTimeout(toast._hideTimer);
    if (type !== "info") {
      toast._hideTimer = setTimeout(() => {
        toast.style.opacity = "0";
      }, 3500);
    }
  }

  /**
   * Copy text to the system clipboard with a textarea fallback
   */
  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (_) {
        // Fallback below if browser blocks async clipboard write
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    Object.assign(textarea.style, { position: "fixed", top: "-9999px", opacity: "0" });
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    if (!ok) throw new Error("Clipboard write blocked.");
  }

  /**
   * Export all intercepted API responses to the clipboard
   */
  async function handleApiMapExport() {
    if (capturedResponses.size === 0) {
      showToast("No character-service calls captured yet. Reload the page (F5).", "error");
      return;
    }

    try {
      const dump = {
        exportedAt: new Date().toISOString(),
        pageUrl: window.location.href,
        count: capturedResponses.size,
        responses: Array.from(capturedResponses.values())
      };

      await copyToClipboard(JSON.stringify(dump, null, 2));
      showToast(`Copied ${capturedResponses.size} intercepted API call(s) to clipboard`, "success");
    } catch (err) {
      console.error("[DDB Exporter] API copy failed:", err);
      showToast(`API copy failed: ${err.message}`, "error");
    }
  }

  /**
   * Export document.body.outerHTML to the clipboard
   */
  async function handleDomExport() {
    if (isCopyingDom) return;
    if (!document.body) {
      showToast("Document body is not ready yet.", "error");
      return;
    }

    isCopyingDom = true;
    try {
      showToast("Copying DOM outerHTML...", "info");
      const bodyContent = document.body.outerHTML;
      await copyToClipboard(bodyContent);
      showToast(`Copied body outerHTML (${bodyContent.length} chars)`, "success");
    } catch (err) {
      console.error("[DDB Exporter] DOM copy failed:", err);
      showToast(`DOM copy failed: ${err.message}`, "error");
    } finally {
      isCopyingDom = false;
    }
  }

  /**
   * Keyboard shortcuts listener in capture phase
   * - Ctrl+Shift+C: Copy intercepted API responses map
   * - Ctrl+Alt+C: Copy document.body.outerHTML
   */
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isCharacterSheetPage()) return;
      if (event.metaKey || !event.ctrlKey) return;

      const isCKey = event.code === "KeyC" || event.key.toLowerCase() === "c";
      if (!isCKey) return;

      if (event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        handleApiMapExport();
        return;
      }

      if (event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        handleDomExport();
      }
    },
    true
  );
})();