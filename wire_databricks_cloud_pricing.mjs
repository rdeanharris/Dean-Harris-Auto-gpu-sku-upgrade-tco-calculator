import fs from "node:fs/promises";
import path from "node:path";

const repo = path.resolve(process.argv[2] || ".");
const marker = "databricks_cloud_pricing_loader.js?version=databricks-cloud-pricing-v1";
const scripts = [
  "  <script src=\"databricks_cloud_pricing_config.js?version=databricks-cloud-pricing-v1\"></script>",
  "  <script src=\"databricks_cloud_pricing_loader.js?version=databricks-cloud-pricing-v1\"></script>",
].join("\n");

const names = (await fs.readdir(repo)).filter((name) => name.endsWith(".html"));
const updated = [];
const alreadyWired = [];

for (const name of names) {
  const file = path.join(repo, name);
  const html = await fs.readFile(file, "utf8");
  if (!html.includes('const data = {"skus"')) continue;
  if (html.includes(marker)) {
    alreadyWired.push(name);
    continue;
  }
  const bodyEnd = html.lastIndexOf("</body>");
  if (bodyEnd < 0) throw new Error(`Unable to find </body> in ${name}`);
  const next = `${html.slice(0, bodyEnd)}${scripts}\n${html.slice(bodyEnd)}`;
  await fs.writeFile(file, next, "utf8");
  updated.push(name);
}

console.log(JSON.stringify({ updated, alreadyWired }, null, 2));
