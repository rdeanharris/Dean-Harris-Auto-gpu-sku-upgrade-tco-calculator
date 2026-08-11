(function loadAuthoritativeCloudPricing() {
  "use strict";

  const config = window.GPU_TCO_CLOUD_PRICING_CONFIG || {};
  if (!config.enabled || !config.apiUrl) return;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), Number(config.requestTimeoutMs) || 45000);

  function formattedPrice(value, decimals = 2) {
    return "$" + Number(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function storedOverride(sku) {
    try {
      const overrides = JSON.parse(window.localStorage.getItem("gpuTcoSkuPriceOverrides") || "{}");
      const raw = overrides && overrides[sku] && overrides[sku].cloud;
      if (raw === null || raw === undefined || raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch (error) {
      return null;
    }
  }

  function applySourcePagePrices(payload) {
    const cells = document.querySelectorAll('[data-price-sku][data-price-basis="cloud"]');
    if (!cells.length) return false;
    cells.forEach((cell) => {
      const sku = decodeURIComponent(cell.dataset.priceSku || "");
      const livePrice = payload.prices[sku];
      const price = Number(livePrice && livePrice.dollarsPerGpuHour);
      if (!Number.isFinite(price) || price <= 0) return;
      cell.dataset.defaultPrice = String(price);
      const override = storedOverride(sku);
      cell.textContent = formattedPrice(override === null ? price : override, Number(cell.dataset.decimals || 2));
      const row = cell.closest("tr");
      if (!row) return;
      const columns = row.querySelectorAll("td");
      if (columns[2]) columns[2].textContent = formattedPrice(price, 2);
      if (columns[4]) columns[4].textContent = Array.isArray(livePrice.providers) && livePrice.providers.length
        ? livePrice.providers.join(", ")
        : "Unified automotive dataset";
      if (columns[5]) columns[5].textContent = String(livePrice.sampleCount || "");
      if (columns[6]) columns[6].textContent = String(payload.source && payload.source.refreshedAt || "").slice(0, 10);
    });
    const note = document.querySelector(".source-note");
    if (note) note.textContent = `Authoritative cloud pricing averages are loaded from ${config.databricksTable}. Manual SKU Price Overrides replace the Databricks average for the selected SKU.`;
    return true;
  }

  function applyCalculatorPrices(payload) {
    if (typeof data === "undefined" || !data.cloudPrices) return false;
    Object.entries(payload.prices).forEach(([sku, livePrice]) => {
      const dollarsPerGpuHour = Number(livePrice && livePrice.dollarsPerGpuHour);
      if (!Number.isFinite(dollarsPerGpuHour) || dollarsPerGpuHour <= 0) return;
      const existing = data.cloudPrices[sku] || { sku, config: sku };
      data.cloudPrices[sku] = {
        ...existing,
        sku,
        dollarsPerGpuHour,
        source: `Databricks: ${config.databricksTable}`,
        notes: `Authoritative average from ${livePrice.sampleCount || 1} record(s)`
          + (Array.isArray(livePrice.providers) && livePrice.providers.length
            ? ` across ${livePrice.providers.join(", ")}.`
            : "."),
      };
    });
    if (typeof update === "function") update();
    return true;
  }

  function applyPrices(payload) {
    if (!payload || !payload.prices) throw new Error("Databricks cloud-pricing data is unavailable.");
    const applied = applyCalculatorPrices(payload) || applySourcePagePrices(payload);
    if (!applied) throw new Error("This page does not expose a cloud-pricing model.");
    document.documentElement.dataset.cloudPricingStatus = "live";
    document.documentElement.dataset.cloudPricingSource = config.databricksTable;
    window.GPU_TCO_CLOUD_PRICING = payload;
    window.dispatchEvent(new CustomEvent("gpu-tco-cloud-pricing-loaded", { detail: payload }));
  }

  const ready = fetch(config.apiUrl, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal: controller.signal,
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Cloud pricing request failed (${response.status}).`);
      applyPrices(payload);
      return payload;
    })
    .catch((error) => {
      document.documentElement.dataset.cloudPricingStatus = "embedded-fallback";
      console.warn("Authoritative Databricks cloud pricing was unavailable; using the embedded offline snapshot.", error);
      return null;
    })
    .finally(() => window.clearTimeout(timeout));

  window.GPU_TCO_CLOUD_PRICING_READY = ready;
})();
