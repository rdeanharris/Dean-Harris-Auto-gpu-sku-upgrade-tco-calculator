import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const port = 18790;
const base = `http://127.0.0.1:${port}`;
const origin = "http://127.0.0.1:8767";
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tco-config-api-"));
const server = spawn(process.execPath, ["server.js"], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    ALLOW_DEV_AUTH: "true",
    ADMIN_EMAILS: "deanh@nvidia.com",
    ALLOWED_ORIGINS: origin,
    PUBLIC_API_BASE_URL: base,
    APP_REDIRECT_URI: `${origin}/GPU_RA_and_NVAIE_TCO_Analysis.html`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.includes("TCO config API listening")) return;
    if (server.exitCode !== null) throw new Error(`API stopped early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`API did not start: ${output}`);
}

async function request(url, options = {}) {
  const response = await fetch(url.startsWith("http") ? url : base + url, {
    redirect: options.redirect || "follow",
    ...options,
    headers: { Origin: origin, "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { response, payload };
}

async function exchangeMagicLink(magicLink) {
  const magic = await request(magicLink, { redirect: "manual" });
  assert.equal(magic.response.status, 302);
  const code = new URL(magic.response.headers.get("location")).searchParams.get("access_code");
  assert.ok(code);
  const exchange = await request("/auth/exchange", { method: "POST", body: { code } });
  assert.equal(exchange.response.status, 200);
  assert.ok(exchange.payload.token);
  return exchange.payload;
}

try {
  await waitForServer();
  const health = await request("/health");
  assert.equal(health.response.status, 200);

  const pending = await request("/registration-requests", {
    method: "POST", body: { email: "alex@example-corp.com", company: "Example Corp", tool: "test" },
  });
  assert.equal(pending.response.status, 202);
  assert.equal(pending.payload.devMagicLink, undefined);

  const blocked = await request("/registration-requests", {
    method: "POST", body: { email: "alex@gmail.com", company: "Personal", tool: "test" },
  });
  assert.equal(blocked.response.status, 400);

  const unauthenticatedInvite = await request("/invitation-requests", {
    method: "POST", body: { email: "casey@customer-corp.com", company: "Customer Corp", tool: "test" },
  });
  assert.equal(unauthenticatedInvite.response.status, 401);

  const adminRequest = await request("/registration-requests", {
    method: "POST", body: { email: "deanh@nvidia.com", company: "NVIDIA", tool: "test" },
  });
  assert.equal(adminRequest.response.status, 202);
  assert.ok(adminRequest.payload.devMagicLink);
  const adminSession = await exchangeMagicLink(adminRequest.payload.devMagicLink);
  assert.equal(adminSession.user.role, "admin");
  const adminHeaders = { Authorization: `Bearer ${adminSession.token}` };

  const dashboard = await request("/admin/dashboard", { headers: adminHeaders });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.payload.pendingRegistrations.length, 1);
  const requestId = dashboard.payload.pendingRegistrations[0].id;

  const approval = await request(`/admin/registration-requests/${requestId}/approve`, {
    method: "POST", headers: adminHeaders, body: { tool: "test" },
  });
  assert.equal(approval.response.status, 200);
  assert.ok(approval.payload.devMagicLink);
  const userSession = await exchangeMagicLink(approval.payload.devMagicLink);
  assert.equal(userSession.user.email, "alex@example-corp.com");
  const userHeaders = { Authorization: `Bearer ${userSession.token}` };

  const invitation = await request("/invitation-requests", {
    method: "POST", headers: userHeaders,
    body: { email: "casey@customer-corp.com", company: "Customer Corp", tool: "test" },
  });
  assert.equal(invitation.response.status, 202);
  assert.ok(invitation.payload.devApprovalLink);
  const emailApproval = await request(invitation.payload.devApprovalLink, { redirect: "manual" });
  assert.equal(emailApproval.response.status, 302);
  const caseyAccess = await request("/auth/request-link", {
    method: "POST", body: { email: "casey@customer-corp.com", tool: "test" },
  });
  assert.ok(caseyAccess.payload.devMagicLink);

  const save = await request("/configs", {
    method: "POST", headers: userHeaders,
    body: { name: "Test configuration", calculator: "test", state: { migrationPaths: [], exemplar: 30 } },
  });
  assert.equal(save.response.status, 200);
  assert.equal(save.payload.config.state.exemplar, 30);

  const configs = await request("/configs", { headers: userHeaders });
  assert.equal(configs.response.status, 200);
  assert.equal(configs.payload.configs.length, 1);

  const finalDashboard = await request("/admin/dashboard", { headers: adminHeaders });
  assert.equal(finalDashboard.payload.pendingRegistrations.length, 0);
  assert.equal(finalDashboard.payload.usageStats.totalLogins, 2);
  assert.equal(finalDashboard.payload.usageStats.configurationsSaved, 1);
  assert.ok(finalDashboard.payload.configsByUser["alex@example-corp.com"]);

  const reused = await request(approval.payload.devMagicLink, { redirect: "manual" });
  assert.equal(reused.response.status, 401);
  console.log("TCO Config API secure-flow test passed");
} finally {
  server.kill("SIGTERM");
  await fs.rm(dataDir, { recursive: true, force: true });
}
