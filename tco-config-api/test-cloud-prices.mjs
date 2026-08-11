import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const apiServerFile = process.argv[2];
if (!apiServerFile) throw new Error("Usage: node test_databricks_cloud_prices.mjs /path/to/server.js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const databricks = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/2.0/sql/statements") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      statement_id: "test-statement",
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [
        { name: "gpu_sku" }, { name: "avg_price_per_gpu_hour" }, { name: "provider" },
      ] } },
      result: { data_array: [
        ["NVIDIA H100 SXM 80GB", "3.00", "AWS"],
        ["H100 80 GB SXM", "5.00", "Azure"],
        ["NVIDIA A10 24GB", "1.20", "AWS"],
      ] },
    }));
  }
  res.writeHead(404).end();
});

const databricksPort = await listen(databricks);
const probe = http.createServer();
const apiPort = await listen(probe);
await new Promise((resolve) => probe.close(resolve));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autotco-databricks-test-"));
const child = spawn(process.execPath, [path.resolve(apiServerFile)], {
  env: {
    ...process.env,
    PORT: String(apiPort),
    DATA_DIR: dataDir,
    ALLOW_DEV_AUTH: "true",
    ADMIN_EMAILS: "deanh@nvidia.com",
    DATABRICKS_HOST: `http://127.0.0.1:${databricksPort}`,
    DATABRICKS_TABLE: "edsp_fdp_nala_fpa_prod.gpu_cloud_model.unified_dataset_automotive",
    DATABRICKS_WAREHOUSE_ID: "test-warehouse",
    DATABRICKS_TOKEN: "test-token",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  let response;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${apiPort}/cloud-prices`, {
        headers: { "x-dev-user-email": "deanh@nvidia.com" },
      });
      break;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert(response, "API server did not start");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source.table, "edsp_fdp_nala_fpa_prod.gpu_cloud_model.unified_dataset_automotive");
  assert.equal(payload.prices["H100 80GB SXM"].dollarsPerGpuHour, 4);
  assert.equal(payload.prices["H100 80GB SXM"].sampleCount, 2);
  assert.deepEqual(payload.prices["H100 80GB SXM"].providers, ["AWS", "Azure"]);
  assert.equal(payload.prices["A10 24GB"].dollarsPerGpuHour, 1.2);
  console.log("Databricks cloud-pricing API test passed");
} finally {
  child.kill("SIGTERM");
  databricks.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
