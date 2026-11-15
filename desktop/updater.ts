// In-app updates from GitHub Releases, without an Apple Developer ID:
// check the latest release, download the app zip, verify its SHA-256 and signature, stage it next to
// the installed app, then swap the bundle after OpenHush quits and relaunch it.
import { app, net } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, createWriteStream, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isNewer } from "./version";

const execFileP = promisify(execFile);

export const REPO = "Akirachang/openhush";
export const ASSET = "OpenHush-mac-arm64.zip";
const FEED = process.env.OPENHUSH_UPDATE_FEED ?? `https://api.github.com/repos/${REPO}/releases/latest`;

export type UpdateState =
  | { status: "idle"; current: string }
  | { status: "checking"; current: string }
  | { status: "available"; current: string; version: string; notesUrl: string }
  | { status: "downloading"; current: string; version: string; fraction: number }
  | { status: "ready"; current: string; version: string }
  | { status: "error"; current: string; version?: string; message: string }
  | { status: "unsupported"; current: string; version: string; notesUrl: string; message: string };

type Release = { version: string; notesUrl: string; zipUrl: string; zipSize: number; shaUrl: string };

/** The .app bundle this process runs from, e.g. /Applications/OpenHush.app. */
export function runningBundle(): string | null {
  const m = app.getPath("exe").match(/^(.*?\.app)\/Contents\/MacOS\//);
  return m ? m[1] : null;
}

export class Updater {
  state: UpdateState = { status: "idle", current: app.getVersion() };
  private release: Release | null = null;
  private staged: { app: string; dir: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private emit: (s: UpdateState) => void,
    private log: (line: string) => void,
    private canRestart: () => string | null, // a reason not to restart now, or null
  ) {}

  /** Updates only make sense for the installed app (never for `electron .` in development). */
  get enabled(): boolean {
    return app.isPackaged && !!runningBundle();
  }

  start() {
    if (!this.enabled) return;
    const delay = Number(process.env.OPENHUSH_UPDATE_DELAY_MS ?? 5000);
    setTimeout(() => void this.check(), delay);
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private set(s: UpdateState) {
    this.state = s;
    this.emit(s);
  }

  private get current() {
    return app.getVersion();
  }

  /** Returns the new version if one is available, null if up to date. Only a manual check throws. */
  async check(manual = false): Promise<string | null> {
    if (!this.enabled) return null;
    if (["downloading", "ready"].includes(this.state.status)) return (this.state as { version: string }).version;
    this.set({ status: "checking", current: this.current });
    try {
      const res = await net.fetch(FEED, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `OpenHush/${this.current}` },
      });
      if (res.status === 404) {
        this.set({ status: "idle", current: this.current }); // no releases published yet
        return null;
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const json = (await res.json()) as {
        tag_name: string;
        html_url: string;
        assets: { name: string; browser_download_url: string; size: number }[];
      };
      const zip = json.assets.find((a) => a.name === ASSET);
      const sha = json.assets.find((a) => a.name === `${ASSET}.sha256`);
      const version = json.tag_name.replace(/^v/i, "");
      if (!isNewer(version, this.current) || !zip || !sha) {
        this.set({ status: "idle", current: this.current });
        return null;
      }
      this.release = { version, notesUrl: json.html_url, zipUrl: zip.browser_download_url, zipSize: zip.size, shaUrl: sha.browser_download_url };
      const blocker = await this.installBlocker();
      if (blocker) {
        this.set({ status: "unsupported", current: this.current, version, notesUrl: json.html_url, message: blocker });
      } else {
        this.set({ status: "available", current: this.current, version, notesUrl: json.html_url });
      }
      this.log(`update ${version} available (running ${this.current})`);
      return version;
    } catch (e) {
      this.log(`update check failed: ${e}`);
      this.set({ status: "idle", current: this.current }); // a failed background check stays quiet
      if (manual) throw e;
      return null;
    }
  }

  /** Why the app can't replace itself where it is, or null when it can. */
  private async installBlocker(): Promise<string | null> {
    const bundle = runningBundle();
    if (!bundle) return "OpenHush isn't running from an app bundle.";
    if (bundle.includes("/AppTranslocation/")) {
      return "Move OpenHush to your Applications folder and reopen it to get updates automatically.";
    }
    try {
      await fs.access(path.dirname(bundle), constants.W_OK);
      await fs.access(bundle, constants.W_OK);
    } catch {
      return "OpenHush can't replace itself in its current folder. Move it to your Applications folder.";
    }
    return null;
  }

  async download(): Promise<void> {
    const rel = this.release;
    const bundle = runningBundle();
    if (!rel || !bundle || this.state.status === "downloading") return;
    const fail = (message: string, detail?: unknown) => {
      this.log(`update download failed: ${message} ${detail ?? ""}`);
      this.set({ status: "error", current: this.current, version: rel.version, message });
    };
    this.set({ status: "downloading", current: this.current, version: rel.version, fraction: 0 });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openhush-update-"));
    const zipPath = path.join(tmp, ASSET);
    try {
      // the published checksum
      const shaRes = await net.fetch(rel.shaUrl);
      if (!shaRes.ok) return fail("Couldn't download the update's checksum.", shaRes.status);
      const expected = (await shaRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected ?? "")) return fail("The update's checksum file is invalid.");

      // the app itself, hashed while it streams to disk
      const res = await net.fetch(rel.zipUrl);
      if (!res.ok || !res.body) return fail("Couldn't download the update.", res.status);
      const total = Number(res.headers.get("content-length")) || rel.zipSize || 0;
      const hash = createHash("sha256");
      const out = createWriteStream(zipPath);
      const reader = res.body.getReader();
      let got = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await once(out, "drain");
        if (total && Date.now() - lastEmit > 150) {
          lastEmit = Date.now();
          this.set({ status: "downloading", current: this.current, version: rel.version, fraction: Math.min(0.99, got / total) });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if (hash.digest("hex") !== expected) return fail("The download didn't pass its integrity check. Please try again.");

      // unpack next to the installed app, so the final swap is an atomic rename
      const stagingDir = path.join(path.dirname(bundle), ".OpenHush-update");
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir);
      await execFileP("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir]);
      const appName = (await fs.readdir(stagingDir)).find((n) => n.endsWith(".app"));
      if (!appName) return fail("The update didn't contain the app.");
      const staged = path.join(stagingDir, appName);
      await execFileP("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]).catch((e) => {
        throw new Error(`signature check failed: ${e}`);
      });
      const { stdout } = await execFileP("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(staged, "Contents", "Info.plist")]);
      if (stdout.trim() !== rel.version) return fail("The downloaded app isn't the expected version.", stdout.trim());

      this.staged = { app: staged, dir: stagingDir };
      this.set({ status: "ready", current: this.current, version: rel.version });
      this.log(`update ${rel.version} staged at ${staged}`);
    } catch (e) {
      fail("Couldn't prepare the update. Please try again.", e);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /** Quit, swap the app bundle, relaunch. Returns a reason if it can't happen right now. */
  install(): string | null {
    const bundle = runningBundle();
    if (!this.staged || !bundle) return "The update isn't ready yet.";
    const busy = this.canRestart();
    if (busy) return busy;
    const script = path.join(os.tmpdir(), `openhush-swap-${process.pid}.sh`);
    const relaunch = process.env.OPENHUSH_UPDATE_NO_RELAUNCH ? "0" : "1";
    const logFile = path.join(os.homedir(), "Library", "Logs", "OpenHush", "update.log");
    const body = `#!/bin/bash
# Written by OpenHush: replaces the app once it has quit, then reopens it.
PID="$1"; TARGET="$2"; NEW="$3"; STAGING="$4"; RELAUNCH="$5"; LOG="$6"
for _ in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
OLD="$TARGET.old-$$"
if mv "$TARGET" "$OLD" && mv "$NEW" "$TARGET"; then
  rm -rf "$OLD"; echo "$(date) updated $TARGET" >> "$LOG"
else
  [ -e "$TARGET" ] || mv "$OLD" "$TARGET"; echo "$(date) update failed, kept the current app" >> "$LOG"
fi
rm -rf "$STAGING" "$0"
[ "$RELAUNCH" = "1" ] && open "$TARGET"
exit 0
`;
    writeFileSync(script, body, { mode: 0o755 });
    const child = spawn("/bin/bash", [script, String(process.pid), bundle, this.staged.app, this.staged.dir, relaunch, logFile], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.log(`installing update: swap ${bundle} after pid ${process.pid} exits`);
    setImmediate(() => app.quit());
    return null;
  }
}
