import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = "http://127.0.0.1:8767";
const files = [
  "GPU_RA_and_NVAIE_TCO_Analysis.html",
  "GM_GPU_RA_and_NVAIE_TCO_Analysis.html",
  "BMW_GPU_RA_and_NVAIE_TCO_Analysis.html",
  "HMG_GPU_RA_and_NVAIE_Impact_Analysis.html",
  "Waabi_GPU_and_NVAIE_TCO_June_22nd.html",
  "Wayve_GPU_and_NVAIE_TCO_June_22nd.html",
  "GPU_and_NVAIE_TCO_June_22nd.html",
  "editable_tco_preview.html",
  "GPU_TCO_June_22nd_User_Password.html",
];

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});

try {
  for (const file of files) {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/${file}?verify=secure-import-export`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#tcoConfigIoControls", { timeout: 15000 });
    const labels = await page.locator("#tcoConfigIoControls button").allTextContents();
    assert.deepEqual(labels, ["Export JSON", "Export Text", "Import Configuration"]);
    assert.deepEqual(pageErrors, [], `${file} page errors: ${pageErrors.join(" | ")}`);
    await page.close();
  }

  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  await page.goto(`${baseUrl}/GPU_RA_and_NVAIE_TCO_Analysis.html?verify=secure-import-export-roundtrip`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#tcoConfigIoControls");
  assert.equal(await page.locator("#authLogin").textContent(), "Email My Approved Access Link");
  assert.equal(await page.locator("#authCreateUser").textContent(), "Request Approval");
  assert.equal(await page.locator("#authPassword").count(), 0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const exported = JSON.parse(await fs.readFile(downloadPath, "utf8"));
  assert.equal(exported.format, "nvidia-gpu-ra-nvaie-tco-config");
  assert.equal(exported.schemaVersion, 1);
  assert.ok(Array.isArray(exported.state.migrationPaths));
  assert.equal(exported.token, undefined);
  assert.equal(exported.users, undefined);

  const originalScale = String(exported.state.scaleQuantities[0]);
  if (await page.locator("#scaleDeploymentBody").getAttribute("hidden") !== null) {
    await page.locator("#scaleDeploymentToggle").click();
  }
  await page.locator("#scaleQty0").fill(String(Number(originalScale) + 123));
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#tcoConfigIoControls input[type=file]").setInputFiles(downloadPath);
  await page.waitForFunction((expected) => document.querySelector("#scaleQty0")?.value === expected, originalScale);
  assert.equal(await page.locator("#scaleQty0").inputValue(), originalScale);
  await page.screenshot({ path: "work/secure_access_import_export_ui.png", fullPage: false });

  const enabledPage = await browser.newPage();
  await enabledPage.route("**/starfleet_auth_config.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.GPU_TCO_STARFLEET_CONFIG={enabled:true,apiBaseUrl:'http://127.0.0.1:8787',blockedPersonalEmailDomains:['gmail.com'],adminEmails:['deanh@nvidia.com']};",
  }));
  await enabledPage.goto(`${baseUrl}/GPU_RA_and_NVAIE_TCO_Analysis.html?verify=enabled-secure-ui`, { waitUntil: "domcontentloaded" });
  assert.equal(await enabledPage.locator("#starfleetLoginPanel").evaluate((node) => node.classList.contains("auth-disabled")), false);
  assert.equal(await enabledPage.locator("body").evaluate((node) => node.classList.contains("access-gate-active")), true);
  assert.equal(await enabledPage.locator("#starfleetLoginPanel").isVisible(), true);
  assert.equal(await enabledPage.locator("#starfleetLoginVisible").isVisible(), false);
  assert.equal(await enabledPage.locator("#authEmail").isEnabled(), true);
  assert.equal(await enabledPage.locator("#authLogin").isEnabled(), true);
  assert.equal(await enabledPage.locator("#authCreateUser").textContent(), "Request Approval");
  assert.equal(await enabledPage.locator("#authLogin").textContent(), "Email My Approved Access Link");
  assert.equal(await enabledPage.locator("#configName").isVisible(), false);
  assert.equal(await enabledPage.getByText("Log In", { exact: true }).count(), 0);
  await enabledPage.screenshot({ path: "work/access_approval_gate.png", fullPage: false });
  await enabledPage.close();
  console.log(`Verified secure UI plus JSON/text import-export controls in ${files.length} calculators`);
} finally {
  await browser.close();
}
