// Copies ../deployments/${LEASH_ENV:-anvil}.json to public/deployments.json so the
// dashboard can serve it as a static file. Run before `dev` and `build`.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env.LEASH_ENV ?? "anvil";
const source = resolve(here, "..", "..", "deployments", `${env}.json`);
const target = resolve(here, "..", "public", "deployments.json");

try {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(`synced ${source} -> ${target}`);
} catch (err) {
  console.error(`could not copy ${source}: ${(err as Error).message}`);
  console.error("Run the Forge deploy scripts first, or set LEASH_ENV=sepolia.");
  process.exit(1);
}
