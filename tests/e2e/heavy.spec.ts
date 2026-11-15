// Heavy repair through the real app. Skipped unless Heavy repair is installed on this Mac.
import { _electron as electron, expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const MARKER = path.join(homedir(), "Library", "Application Support", "OpenHush", "engine", "heavy", "installed.json");

test.skip(!existsSync(MARKER), "Heavy repair is not installed");

test("heavy repair: preview and clean", async () => {
  const profile = mkdtempSync(path.join(tmpdir(), "openhush-profile-"));
  const packaged = process.env.OPENHUSH_APP;
  const app = await electron.launch({
    ...(packaged ? { executablePath: path.join(packaged, "Contents", "MacOS", "OpenHush") } : {}),
    args: packaged ? ["--mute-audio"] : [ROOT, "--mute-audio"],
    cwd: ROOT,
    env: { ...process.env, OPENHUSH_USER_DATA: profile },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
    const dir = mkdtempSync(path.join(tmpdir(), "openhush-e2e-"));
    const src = path.join(dir, "noisy.flac");
    copyFileSync(path.join(ROOT, "engine", "test_media", "noisy.flac"), src);
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
    }, src);
    await page.getByRole("button", { name: "Add files" }).first().click();

    const heavy = page.getByRole("checkbox", { name: "Heavy repair" });
    await expect(heavy).toBeEnabled();
    await heavy.check();
    await expect(page.getByText("100% (fixed)")).toBeVisible();
    await expect(page.getByLabel("Mix")).toBeDisabled();

    await page.getByRole("button", { name: "Play preview" }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 120_000 });

    await page.getByRole("button", { name: "Clean 1 file" }).click();
    await expect(page.getByText(/^1 cleaned/)).toBeVisible({ timeout: 180_000 });
    expect(existsSync(path.join(dir, "noisy_clean.flac"))).toBe(true);
  } finally {
    await app.close();
  }
});
