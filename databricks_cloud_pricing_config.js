window.GPU_TCO_CLOUD_PRICING_CONFIG = Object.freeze({
  enabled: true,
  apiUrl: window.location.hostname === "autotco.nvidia.com"
    ? "/api/cloud-prices"
    : "https://autotco.nvidia.com/api/cloud-prices",
  databricksHost: "https://nvidia-edsp-fdp-prd.cloud.databricks.com",
  databricksTable: "edsp_fdp_nala_fpa_prod.gpu_cloud_model.unified_dataset_automotive",
  requestTimeoutMs: 45000,
});
