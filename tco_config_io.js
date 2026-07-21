(function () {
  "use strict";

  const bridge = window.GPU_TCO_CONFIG_IO;
  if (!bridge || typeof bridge.collectState !== "function" || typeof bridge.applyState !== "function") return;

  const FORMAT = "nvidia-gpu-ra-nvaie-tco-config";
  const SCHEMA_VERSION = 1;
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  const JSON_START = "---BEGIN CONFIG JSON---";
  const JSON_END = "---END CONFIG JSON---";

  function safeFileBase(value) {
    return String(value || "GPU_RA_and_NVAIE_TCO_Analysis")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90) || "GPU_RA_and_NVAIE_TCO_Analysis";
  }

  function envelope() {
    return {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      calculator: String(bridge.calculator || document.title || "GPU, RA and NVAIE TCO Analysis"),
      exportedAt: new Date().toISOString(),
      state: bridge.collectState(),
    };
  }

  function localStorageKey() {
    return "nvidiaTcoSavedConfiguration:" + safeFileBase(bridge.calculator || document.title);
  }

  function saveConfigurationLocally() {
    try {
      const value = envelope();
      value.savedAt = new Date().toISOString();
      window.localStorage.setItem(localStorageKey(), JSON.stringify(value));
      showStatus("Configuration saved in this browser. It will be restored when you return.");
    } catch {
      throw new Error("This browser could not save the configuration locally.");
    }
  }

  function loadConfigurationLocally() {
    let raw;
    try {
      raw = window.localStorage.getItem(localStorageKey());
    } catch {
      throw new Error("This browser could not read the saved configuration.");
    }
    if (!raw) throw new Error("No saved configuration was found in this browser.");
    const value = JSON.parse(raw);
    const state = value?.format === FORMAT ? value.state : value?.state || value;
    validateState(state);
    bridge.applyState(state);
    showStatus("Saved configuration loaded from this browser.");
  }

  function restoreLocalConfiguration() {
    try {
      const raw = window.localStorage.getItem(localStorageKey());
      if (!raw) return;
      const value = JSON.parse(raw);
      const state = value?.format === FORMAT ? value.state : value?.state || value;
      validateState(state);
      bridge.applyState(state);
      showStatus("Your locally saved configuration was restored.");
    } catch {
      window.localStorage.removeItem(localStorageKey());
    }
  }

  function download(contents, type, extension) {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFileBase(bridge.calculator || document.title) + "_configuration." + extension;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    download(JSON.stringify(envelope(), null, 2) + "\n", "application/json", "json");
    showStatus("Configuration exported as JSON.");
  }

  function exportText() {
    const value = envelope();
    const text = [
      "NVIDIA GPU, RA and NVAIE TCO Configuration",
      "Calculator: " + value.calculator,
      "Exported: " + value.exportedAt,
      "Schema: " + value.schemaVersion,
      "",
      JSON_START,
      JSON.stringify(value, null, 2),
      JSON_END,
      "",
    ].join("\n");
    download(text, "text/plain", "txt");
    showStatus("Configuration exported as text.");
  }

  function parseImport(text) {
    const trimmed = String(text || "").trim();
    let jsonText = trimmed;
    const start = trimmed.indexOf(JSON_START);
    if (start >= 0) {
      const end = trimmed.indexOf(JSON_END, start + JSON_START.length);
      if (end < 0) throw new Error("The text configuration is missing its closing marker.");
      jsonText = trimmed.slice(start + JSON_START.length, end).trim();
    }
    let value;
    try {
      value = JSON.parse(jsonText);
    } catch {
      throw new Error("This file is not a valid TCO JSON or text configuration.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration file is invalid.");
    const state = value.format === FORMAT ? value.state : value.state || value;
    if (value.format && value.format !== FORMAT) throw new Error("This file was not exported by the NVIDIA GPU TCO calculator.");
    if (value.schemaVersion && Number(value.schemaVersion) > SCHEMA_VERSION) throw new Error("This configuration uses a newer unsupported format.");
    validateState(state);
    return state;
  }

  function validateState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Configuration state is missing.");
    if (state.migrationPaths !== undefined) {
      if (!Array.isArray(state.migrationPaths)) throw new Error("GPU scenario rows are invalid.");
      if (state.migrationPaths.length > 100) throw new Error("Configuration contains too many GPU scenario rows.");
      for (const row of state.migrationPaths) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("A GPU scenario row is invalid.");
      }
    }
    if (state.scaleQuantities !== undefined && (!Array.isArray(state.scaleQuantities) || state.scaleQuantities.length > 20)) {
      throw new Error("Scale quantities are invalid.");
    }
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) throw new Error("Configuration file must be smaller than 2 MB.");
    const state = parseImport(await file.text());
    if (!window.confirm("Importing will replace the current calculator inputs. Continue?")) return;
    bridge.applyState(state);
    const imported = envelope();
    imported.savedAt = new Date().toISOString();
    window.localStorage.setItem(localStorageKey(), JSON.stringify(imported));
    showStatus("Configuration imported from " + file.name + ".");
  }

  function showStatus(message) {
    const status = document.getElementById("saveStatus") || document.getElementById("authStatus");
    if (status) status.textContent = message;
  }

  function makeButton(label, action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "config-io-button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function install() {
    const actions = document.querySelector(".file-actions") || document.querySelector("main") || document.body;
    if (!actions || document.documentElement.dataset.configIoInstalled === "true") return;
    document.documentElement.dataset.configIoInstalled = "true";

    // The source calculator still carries internal workbook links for legacy builds.
    // Remove that internal-only view while leaving the Core Source Data tabs intact.
    document.getElementById("hiddenWorkbookToggle")?.remove();
    document.getElementById("hiddenWorkbookTabs")?.remove();

    const style = document.createElement("style");
    style.textContent = [
      ".config-io-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".config-io-button{border:1px solid #111;background:#fff;color:#111;min-height:30px;padding:5px 10px;font:700 12px Arial,sans-serif;cursor:pointer;border-radius:0}",
      ".config-io-button:hover,.config-io-button:focus-visible{background:#e8f5d1;outline:2px solid #76b900;outline-offset:1px}",
      "@media print{.config-io-controls{display:none!important}}",
    ].join("");
    document.head.appendChild(style);

    const saveButton = document.getElementById("topSaveConfigurationButton");
    const loadButton = document.getElementById("topLoadConfigurationButton");
    const feedbackButton = document.getElementById("sendFeedbackButton");
    saveButton?.addEventListener("click", () => {
      try {
        saveConfigurationLocally();
      } catch (error) {
        showStatus(error.message || "Unable to save configuration.");
        window.alert(error.message || "Unable to save configuration.");
      }
    });
    loadButton?.addEventListener("click", () => {
      try {
        loadConfigurationLocally();
      } catch (error) {
        showStatus(error.message || "Unable to load configuration.");
        window.alert(error.message || "Unable to load configuration.");
      }
    });
    feedbackButton?.addEventListener("click", () => {
      const subject = "NVIDIA TCO Analysis feedback";
      const body = [
        "Please share your feedback below:",
        "",
        "",
        "Calculator: " + String(bridge.calculator || document.title || "NVIDIA TCO Analysis"),
        "Page: " + window.location.href,
      ].join("\n");
      window.location.href = "mailto:deanh@nvidia.com?subject=" + encodeURIComponent(subject)
        + "&body=" + encodeURIComponent(body);
    });
    restoreLocalConfiguration();
  }

  install();
}());
