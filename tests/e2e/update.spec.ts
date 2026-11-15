// In-app updates. The self-update tests need the packaged app:
//   npm run dist && OPENHUSH_APP=dist/mac-arm64/OpenHush.app npx playwright test update
// They install a copy into a temporary "Applications" folder and serve a fake newer release locally.
import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNewer } from "../../desktop/version";

const PACKAGED = process.env.OPENHUSH_APP;
const ASSET = "OpenHush-mac-arm64.zip";

test("version comparison", () => {
  expect(isNewer("0.2.0", "0.1.0")).toBe(true);
  expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("1.0.0-beta.1", "0.9.0")).toBe(true);
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.2", "0.2.0")).toBe(false);
  expect(isNewer("0.1.9", "0.2.0")).toBe(false);
});

const plist = (app: string, key: string) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents", "Info.plist")]).toString().trim();

test.describe("self-update (packaged app)", () => {
  test.skip(!PACKAGED, "set OPENHUSH_APP to a built OpenHush.app");
  test.setTimeout(300_000);

  let files = "";
  let goodSha = "";
  let current = "";
  let server: Server;
  let base = "";
  let serveCorrupt = false;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    current = plist(PACKAGED!, "CFBundleShortVersionString");
    // the "next release": the same app, version 9.9.9, with a marker file, re-signed
    const root = mkdtempSync(path.join(tmpdir(), "openhush-release-"));
    const next = path.join(root, "OpenHush.app");
    execFileSync("ditto", [PACKAGED!, next]);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleShortVersionString 9.9.9", path.join(next, "Contents", "Info.plist")]);
    writeFileSync(path.join(next, "Contents", "Resources", "update-marker.txt"), "9.9.9\n");
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", next]);
    files = path.join(root, "files");
    mkdirSync(files);
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", next, path.join(files, ASSET)]);
    goodSha = createHash("sha256").update(readFileSync(path.join(files, ASSET))).digest("hex");

    server = createServer((req, res) => {
      if (req.url === "/releases/latest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          tag_name: "v9.9.9",
          html_url: `${base}/notes`,
          assets: [
            { name: ASSET, browser_download_url: `${base}/dl/${ASSET}`, size: statSync(path.join(files, ASSET)).size },
            { name: `${ASSET}.sha256`, browser_download_url: `${base}/dl/${ASSET}.sha256`, size: 90 },
          ],
        }));
      } else if (req.url === `/dl/${ASSET}.sha256`) {
        res.end(`${serveCorrupt ? "0".repeat(64) : goodSha}  ${ASSET}\n`);
      } else if (req.url === `/dl/${ASSET}`) {
        res.setHeader("content-length", String(statSync(path.join(files, ASSET)).size));
        createReadStream(path.join(files, ASSET)).pipe(res);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(() => server?.close());

  /** Installs a fresh copy of the packaged app into a temporary Applications folder and launches it. */
  async function launchInstalled(relaunch = false) {
    const apps = path.join(mkdtempSync(path.join(tmpdir(), "openhush-apps-")), "Applications");
    mkdirSync(apps);
    const installed = path.join(apps, "OpenHush.app");
    execFileSync("ditto", [PACKAGED!, installed]);
    const app = await electron.launch({
      executablePath: path.join(installed, "Contents", "MacOS", "OpenHush"),
      args: ["--mute-audio"],
      env: {
        ...process.env,
        OPENHUSH_USER_DATA: mkdtempSync(path.join(tmpdir(), "openhush-profile-")),
        OPENHUSH_UPDATE_FEED: `${base}/releases/latest`,
        OPENHUSH_UPDATE_DELAY_MS: "300",
        ...(relaunch ? {} : { OPENHUSH_UPDATE_NO_RELAUNCH: "1" }),
      },
    });
    return { app, page: await app.firstWindow(), apps, installed };
  }

  test("downloads, verifies, swaps the app, relaunches it and leaves nothing behind", async () => {
    serveCorrupt = false;
    const { app, page, apps, installed } = await launchInstalled(true);
    await expect(page.getByText(`OpenHush 9.9.9 is available. You have ${current}.`)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Update", exact: true }).click();
    const restart = page.getByRole("button", { name: "Restart to update" });
    await expect(restart).toBeVisible({ timeout: 120_000 });
    const closed = app.waitForEvent("close");
    await restart.click();
    await closed;

    await expect.poll(() => plist(installed, "CFBundleShortVersionString"), { timeout: 30_000 }).toBe("9.9.9");
    expect(existsSync(path.join(installed, "Contents", "Resources", "update-marker.txt"))).toBe(true);
    execFileSync("codesign", ["--verify", "--deep", "--strict", installed]); // throws if the swapped app is broken
    await expect.poll(() => readdirSync(apps), { timeout: 10_000 }).toEqual(["OpenHush.app"]); // no staging or backup copies

    // the updated app starts by itself; close it again
    const exe = path.join(realpathSync(installed), "Contents", "MacOS", "OpenHush"); // /var is a symlink to /private/var
    const pidOf = () => {
      try {
        return execFileSync("pgrep", ["-f", `^${exe}`]).toString().trim().split("\n")[0];
      } catch {
        return "";
      }
    };
    await expect.poll(pidOf, { timeout: 30_000 }).not.toBe("");
    process.kill(Number(pidOf()), "SIGTERM");
    await expect.poll(pidOf, { timeout: 30_000 }).toBe("");
  });

  test("a corrupted download is rejected and the app is untouched", async () => {
    serveCorrupt = true;
    const { app, page, apps, installed } = await launchInstalled();
    await expect(page.getByText(`OpenHush 9.9.9 is available.`)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect(page.getByText(/didn't pass its integrity check/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(plist(installed, "CFBundleShortVersionString")).toBe(current);
    expect(readdirSync(apps)).toEqual(["OpenHush.app"]);
    await app.close();
  });
});
