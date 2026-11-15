// Captures the README screenshots and the A/B GIF from the real app, in dark mode, at 2x.
// Run: npm run readme:assets   (writes raw captures to build/readme/out/, then compose.cjs frames them)
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MEDIA = path.join(ROOT, "engine", "test_media");
const OUT = path.join(ROOT, "build", "readme", "out");
const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Realistic-looking demo files made from the noisy test clips. */
function demoMedia() {
  const dir = mkdtempSync(path.join(tmpdir(), "openhush-demo-"));
  const loop = (src, n, out) => ff("-stream_loop", String(n), "-i", path.join(MEDIA, src), "-c", "copy", path.join(dir, out));
  loop("noisy.mp4", 5, "podcast_ep12.mp4");
  loop("noisy_44k_stereo.wav", 2, "interview_raw.wav");
  loop("noisy.mov", 1, "street_vlog.mov");
  loop("noisy.m4a", 0, "voice_memo.m4a");
  loop("noisy_48k_mono.wav", 17, "lecture_recording.wav");
  return dir;
}

async function launch() {
  const app = await electron.launch({
    args: ["--force-device-scale-factor=2", ROOT, "--mute-audio"], // Chromium switches go before the app path
    cwd: ROOT,
    env: { ...process.env, OPENHUSH_USER_DATA: mkdtempSync(path.join(tmpdir(), "openhush-profile-")) },
  });
  const page = await app.firstWindow();
  // (no setViewportSize: it would reset the 2x scale; the window is already 1280 x 820)
  await page.emulateMedia({ colorScheme: null });
  await page.evaluate(() => window.openhush.setTheme("dark"));
  await page.getByText("Starting the audio engine…").waitFor({ state: "hidden", timeout: 60_000 });
  const add = async (files) => {
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p });
    }, files);
    await page.getByRole("button", { name: "Add files" }).first().click();
  };
  return { app, page, add };
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const demo = demoMedia();
  const f = (n) => path.join(demo, n);

  // Scene 1: the preview, with one file already cleaned
  {
    const { app, page, add } = await launch();
    await add([f("interview_raw.wav")]);
    await page.getByRole("button", { name: "Clean 1 file" }).click();
    await page.getByText(/^1 cleaned/).waitFor({ timeout: 120_000 });
    await add([f("podcast_ep12.mp4"), f("street_vlog.mov"), f("voice_memo.m4a")]);
    await page.getByRole("button", { name: /^podcast_ep12\.mp4/ }).click();
    await page.getByRole("slider", { name: "Preview section" }).waitFor();
    await page.getByLabel("Strength").fill("34");
    await sleep(800);
    await page.getByRole("button", { name: "Play preview" }).click();
    await page.getByRole("button", { name: "Pause" }).waitFor({ timeout: 60_000 });
    await sleep(2600);
    await page.mouse.move(640, 810);
    await page.screenshot({ path: path.join(OUT, "preview.png") });

    // GIF: the centre pane while switching Original <-> Cleaned
    const box = await page.locator("main").boundingBox();
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
    let n = 0;
    const t0 = Date.now();
    const cleanedBtn = page.getByRole("button", { name: "Cleaned", exact: true });
    const originalBtn = page.getByRole("button", { name: "Original", exact: true });
    for (const target of [originalBtn, cleanedBtn, originalBtn, cleanedBtn]) {
      await target.click();
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        await page.screenshot({ path: path.join(OUT, "frames", `f${String(n++).padStart(4, "0")}.png`), clip });
      }
    }
    const fps = n / ((Date.now() - t0) / 1000);
    writeFileSync(path.join(OUT, "frames", "fps.txt"), fps.toFixed(2));
    await page.getByRole("button", { name: "Pause" }).click();
    await app.close();
  }

  // Scene 2: a batch in progress
  {
    const { app, page, add } = await launch();
    await add([f("lecture_recording.wav"), f("podcast_ep12.mp4"), f("street_vlog.mov")]);
    await page.getByRole("button", { name: "Clean 3 files" }).click();
    await page.getByText(/Cleaning (3\d|4\d|5\d)%/).first().waitFor({ timeout: 120_000 });
    await page.mouse.move(640, 810);
    await page.screenshot({ path: path.join(OUT, "batch.png") });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByText(/^Cancelled ·/).first().waitFor({ timeout: 30_000 });
    await app.close();
  }

  // GIF from the frames (palette-optimised, 960 px wide)
  const fps = readFileSync(path.join(OUT, "frames", "fps.txt"), "utf8").trim();
  ff("-framerate", fps, "-i", path.join(OUT, "frames", "f%04d.png"),
    "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop", "0", path.join(ROOT, ".github", "assets", "ab-compare.gif"));
  rmSync(demo, { recursive: true, force: true });
  console.log("captured preview.png, batch.png and ab-compare.gif");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
