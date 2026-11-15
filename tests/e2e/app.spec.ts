// End-to-end: launches the real Electron app (built UI + Python engine) and drives it like a user.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const MEDIA = path.join(ROOT, "engine", "test_media");
const SHOTS = process.env.OPENHUSH_SHOTS;

let app: ElectronApplication;
let page: Page;

async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), "openhush-profile-"));
  // OPENHUSH_APP=/path/to/OpenHush.app runs the same tests against the packaged app.
  const packaged = process.env.OPENHUSH_APP;
  app = await electron.launch({
    ...(packaged ? { executablePath: path.join(packaged, "Contents", "MacOS", "OpenHush") } : {}),
    args: packaged ? ["--mute-audio"] : [ROOT, "--mute-audio"],
    cwd: ROOT,
    env: { ...process.env, OPENHUSH_USER_DATA: profile },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 820 });
}

/** Make File › Add Files… return these paths (stubs the native dialog in the main process). */
async function stubOpenDialog(paths: string[]) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as typeof dialog.showOpenDialog;
  }, paths);
}

function workdir(...names: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "openhush-e2e-"));
  return names.map((n) => {
    copyFileSync(path.join(MEDIA, n), path.join(dir, n));
    return path.join(dir, n);
  });
}

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.beforeEach(launch);
test.afterEach(async () => {
  await app.close();
});

test("full flow: add, preview, A/B, clean", async () => {
  await expect(page).toHaveTitle("OpenHush");
  await expect(page.getByText("Drop audio or video.")).toBeVisible();
  await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
  await shot("1-empty-light");

  const files = workdir("noisy.mp4", "noisy_44k_stereo.wav", "noisy.mp3", "fake.mp4");
  await stubOpenDialog(files);
  await page.getByRole("button", { name: "Add files" }).first().click();

  // queue: three good files and one friendly error
  await expect(page.getByText("Queue · 4")).toBeVisible();
  await expect(page.getByRole("button", { name: /^fake\.mp4: Couldn.t read/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^noisy\.mp4: MP4 · 48 kHz · stereo/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clean 3 files" })).toBeEnabled();

  // the first file is selected: overview strip, then preview
  await expect(page.getByRole("heading", { name: "noisy" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Preview section" })).toBeVisible();
  await page.getByRole("button", { name: "Play preview" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^0:0\d \/ 0:15$/)).toBeVisible();

  // A/B: Tab flips between Original and Cleaned
  const cleaned = page.getByRole("button", { name: "Cleaned", exact: true });
  const original = page.getByRole("button", { name: "Original", exact: true });
  await expect(cleaned).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(original).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(cleaned).toHaveAttribute("aria-pressed", "true");
  await shot("2-preview-light");

  // strength change re-renders the preview, keeps playing
  await page.getByLabel("Strength").fill("60");
  await expect(page.getByText("60 dB")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 60_000 });

  // error file shows its message in the main pane
  await page.getByRole("button", { name: /^fake\.mp4/ }).click();
  await expect(page.getByText("Can't clean this file")).toBeVisible();
  await expect(page.getByText(/not a real MP4 file/).first()).toBeVisible();

  // clean all
  await page.getByRole("button", { name: "Clean 3 files" }).click();
  await expect(page.getByText(/^3 cleaned/)).toBeVisible({ timeout: 120_000 });
  const dir = path.dirname(files[0]);
  for (const out of ["noisy_clean.mp4", "noisy_44k_stereo_clean.wav", "noisy_clean.mp3"]) {
    expect(existsSync(path.join(dir, out)), out).toBe(true);
  }
  expect(readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]); // no partial files
  await page.getByRole("button", { name: /^noisy\.mp4/ }).click();
  await expect(page.getByText("Saved as noisy_clean.mp4")).toBeVisible();
  await shot("3-done-light");

  // dark mode: stop Playwright's default light-scheme emulation so the app's own switch is what's tested
  await page.emulateMedia({ colorScheme: null });
  await page.evaluate(() => window.openhush!.setTheme("dark"));
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  await shot("4-done-dark");
  await page.evaluate(() => window.openhush!.setTheme("system"));
});

test("cancel leaves nothing behind", async () => {
  await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
  const dir = mkdtempSync(path.join(tmpdir(), "openhush-e2e-"));
  const { execFileSync } = await import("node:child_process");
  const long = path.join(dir, "long.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-stream_loop", "17", "-i", path.join(MEDIA, "noisy_48k_mono.wav"), "-c", "copy", long]);
  await stubOpenDialog([long]);
  await page.getByRole("button", { name: "Add files" }).first().click();
  await page.getByRole("button", { name: "Clean 1 file" }).click();
  await expect(page.getByText(/Cleaning [1-9]\d?%/).first()).toBeVisible({ timeout: 60_000 });
  await shot("5-running-light");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/^Cancelled · 0 of 1 finished/)).toBeVisible({ timeout: 30_000 });
  expect(readdirSync(dir)).toEqual(["long.wav"]);
});

test("recovers when the engine crashes", async () => {
  await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
  const { execFileSync } = await import("node:child_process");
  const pids = execFileSync("pgrep", ["-f", "openhush(_engine[.]server|-engine/openhush-engine)"]).toString().trim().split("\n");
  for (const pid of pids) process.kill(Number(pid), "SIGKILL");
  await expect(page.getByText(/audio engine stopped unexpectedly/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/audio engine stopped unexpectedly/)).toBeHidden({ timeout: 60_000 });
  await stubOpenDialog(workdir("noisy.flac"));
  await page.getByRole("button", { name: "Add files" }).first().click();
  await expect(page.getByRole("button", { name: /^noisy\.flac: FLAC/ })).toBeVisible({ timeout: 30_000 });
});

test("keyboard: arrows move the selection, A/B choose a side", async () => {
  await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
  await stubOpenDialog(workdir("noisy.mp3", "noisy.flac"));
  await page.getByRole("button", { name: "Add files" }).first().click();
  await expect(page.getByRole("heading", { name: "noisy" })).toBeVisible();
  await expect(page.getByText(/^MP3 · 44\.1 kHz/).first()).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[aria-current=true]")).toHaveAttribute("aria-label", /^noisy\.flac/);
  await page.keyboard.press("a");
  await expect(page.getByRole("button", { name: "Original", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("b");
  await expect(page.getByRole("button", { name: "Cleaned", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("changing Strength right after Play still starts playback", async () => {
  await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
  await stubOpenDialog(workdir("noisy_44k_stereo.wav"));
  await page.getByRole("button", { name: "Add files" }).first().click();
  await expect(page.getByRole("slider", { name: "Preview section" })).toBeVisible();
  await page.getByRole("button", { name: "Play preview" }).click();
  await page.getByLabel("Strength").fill("45"); // supersedes the render that is in flight
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 60_000 });
});

test("quitting mid-batch asks first (⌘Q and closing the window)", async () => {
  await expect(page.getByText("Starting the audio engine…")).toBeHidden({ timeout: 60_000 });
  const dir = mkdtempSync(path.join(tmpdir(), "openhush-e2e-"));
  const { execFileSync } = await import("node:child_process");
  const long = path.join(dir, "long.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-stream_loop", "17", "-i", path.join(MEDIA, "noisy_48k_mono.wav"), "-c", "copy", long]);
  await stubOpenDialog([long]);
  await page.getByRole("button", { name: "Add files" }).first().click();
  await page.getByRole("button", { name: "Clean 1 file" }).click();
  await expect(page.getByText(/Cleaning [1-9]\d?%/).first()).toBeVisible({ timeout: 60_000 });

  // answer "Keep Cleaning": the app must stay open
  await app.evaluate(({ dialog }) => {
    (globalThis as { asked?: number }).asked = 0;
    dialog.showMessageBoxSync = ((..._args: unknown[]) => {
      (globalThis as { asked?: number }).asked! += 1;
      return 0;
    }) as typeof dialog.showMessageBoxSync;
  });
  await app.evaluate(({ app: a }) => a.quit()); // ⌘Q
  await page.waitForTimeout(500);
  expect(await app.evaluate(() => (globalThis as { asked?: number }).asked)).toBe(1);
  await expect(page.getByText(/Cleaning \d+%/).first()).toBeVisible();

  // closing the window asks too
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(500);
  expect(await app.evaluate(() => (globalThis as { asked?: number }).asked)).toBe(2);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  // answer "Stop and Quit": the app closes, and no half-written file is left behind
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
  });
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app: a }) => a.quit());
  await closed;
  expect(readdirSync(dir)).toEqual(["long.wav"]);
  await launch(); // so afterEach has an app to close
});
