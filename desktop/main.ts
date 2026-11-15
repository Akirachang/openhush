// OpenHush desktop shell: window, menu, file dialogs, the engine process, and the bridge to the UI.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, session, shell } from "electron";
import { appendFileSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EngineBridge, EngineError, resolveEngineCommand } from "./engine";
import { Updater } from "./updater";

const DEV_URL = process.env.OPENHUSH_DEV_URL;
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI_DIR = app.isPackaged ? path.join(process.resourcesPath, "ui") : path.join(REPO_ROOT, "ui", "out");
const LOG_DIR = path.join(homedir(), "Library", "Logs", "OpenHush");
const PREFS_FILE = () => path.join(app.getPath("userData"), "preferences.json");

app.setName("OpenHush");
// Tests run with their own profile so they never touch the user's settings.
if (process.env.OPENHUSH_USER_DATA) app.setPath("userData", process.env.OPENHUSH_USER_DATA);
mkdirSync(LOG_DIR, { recursive: true });
const log = (line: string) => {
  try {
    appendFileSync(path.join(LOG_DIR, "app.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never crash the app */
  }
};

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

let win: BrowserWindow | null = null;
let engine: EngineBridge | null = null;
let previewDir = "";
let batchRunning = false;
let quitting = false;
let restarts = 0;

const updater = new Updater(
  (state) => win?.webContents.send("update:state", state),
  log,
  () => (batchRunning ? "Finish or cancel the cleaning first, then restart to update." : null),
);

/** Asks before quitting mid-batch. True when it's fine to quit. */
function confirmQuitDuringBatch(): boolean {
  if (!batchRunning) return true;
  const options: Electron.MessageBoxSyncOptions = {
    type: "warning",
    buttons: ["Keep Cleaning", "Stop and Quit"],
    defaultId: 0,
    cancelId: 0,
    message: "OpenHush is still cleaning files.",
    detail: "If you quit now, the file being cleaned is discarded. Finished files are kept.",
  };
  return (win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)) === 1;
}

async function checkForUpdatesManually() {
  if (!updater.enabled) {
    await dialog.showMessageBox(win!, {
      message: "Updates work in the installed app.",
      detail: "This copy runs from source. Pull the latest code to update it.",
    });
    return;
  }
  try {
    const version = await updater.check(true);
    if (!version) {
      await dialog.showMessageBox(win!, { message: "You're up to date.", detail: `OpenHush ${app.getVersion()} is the latest version.` });
    }
  } catch {
    await dialog.showMessageBox(win!, {
      type: "warning",
      message: "Couldn't check for updates.",
      detail: "Check your internet connection and try again.",
    });
  }
}

// ------------------------------------------------------------------ preferences (theme)

type ThemeMode = "system" | "light" | "dark";
function readPrefs(): { theme?: ThemeMode } {
  try {
    return JSON.parse(readFileSync(PREFS_FILE(), "utf8"));
  } catch {
    return {};
  }
}
function setTheme(mode: ThemeMode) {
  nativeTheme.themeSource = mode;
  try {
    writeFileSync(PREFS_FILE(), JSON.stringify({ ...readPrefs(), theme: mode }));
  } catch (e) {
    log(`prefs write failed: ${e}`);
  }
  buildMenu();
}

// ------------------------------------------------------------------ engine

async function startEngine() {
  const cmd = resolveEngineCommand({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: REPO_ROOT });
  engine = new EngineBridge(cmd, log);
  engine.on("*", (name: string, data: unknown) => {
    if (name === "batchFinished") batchRunning = false;
    win?.webContents.send("engine:event", name, data);
  });
  engine.on("engineExit", (info) => {
    log(`engine exited: ${JSON.stringify(info)}`);
    batchRunning = false;
    win?.webContents.send("engine:event", "engineExit", info);
    if (!quitting && restarts < 3) {
      restarts += 1;
      setTimeout(() => startEngine().catch((e) => log(`engine restart failed: ${e}`)), 500 * restarts);
    }
  });
  await engine.start();
  const hello = await engine.call<{ previewDir: string; version: string; engineReady: boolean; ffmpeg: { ok: boolean } }>("hello");
  previewDir = hello.previewDir;
  log(`engine ${hello.version} ready: ffmpeg=${hello.ffmpeg.ok} deepFilter=${hello.engineReady} packaged=${app.isPackaged}`);
  win?.webContents.send("engine:event", "engineReady", hello);
}

function isInside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return !!parent && !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ------------------------------------------------------------------ IPC

ipcMain.handle("engine:call", async (_e, method: string, params: Record<string, unknown>) => {
  if (!engine) throw new Error(JSON.stringify({ message: "The audio engine is starting…" }));
  try {
    const result = await engine.call(method, params);
    if (method === "startBatch") batchRunning = true;
    if (method === "hello") previewDir = (result as { previewDir: string }).previewDir;
    return result;
  } catch (err) {
    // ipcRenderer.invoke only carries Error.message across, so encode the structured error in it
    const e = err as EngineError;
    throw new Error(JSON.stringify({ message: e.message ?? String(err), details: e.details ?? "", cancelled: !!e.cancelled }));
  }
});

ipcMain.handle("engine:restart", async () => {
  restarts = 0;
  await engine?.stop();
  await startEngine();
});

ipcMain.handle("dialog:openFiles", async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: "Add files",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "Audio & video", extensions: ["wav", "mp3", "m4a", "flac", "mp4", "mov", "mkv"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("shell:reveal", (_e, p: string) => {
  if (typeof p === "string" && path.isAbsolute(p)) shell.showItemInFolder(p);
});

ipcMain.handle("preview:read", async (_e, p: string) => {
  if (typeof p !== "string" || !isInside(path.resolve(p), previewDir)) throw new Error("not a preview file");
  const buf = await fs.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle("update:get", () => updater.state);
ipcMain.handle("update:download", () => updater.download());
ipcMain.handle("update:install", () => updater.install());

ipcMain.handle("theme:get", () => nativeTheme.themeSource);
ipcMain.handle("theme:set", (_e, mode: ThemeMode) => {
  if (["system", "light", "dark"].includes(mode)) setTheme(mode);
});

// ------------------------------------------------------------------ window & menu

function send(command: string) {
  win?.webContents.send("menu", command);
}

function buildMenu() {
  const mode = nativeTheme.themeSource;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => void checkForUpdatesManually() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Add Files…", accelerator: "CmdOrCtrl+O", click: () => send("add-files") },
        { label: "Clean Files", accelerator: "CmdOrCtrl+Return", click: () => send("clean") },
        { type: "separator" },
        { label: "Show in Finder", accelerator: "CmdOrCtrl+Shift+R", click: () => send("reveal") },
        { label: "Remove from List", accelerator: "CmdOrCtrl+Backspace", click: () => send("remove") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Appearance",
          submenu: (["system", "light", "dark"] as ThemeMode[]).map((m) => ({
            label: m === "system" ? "Match System" : m[0].toUpperCase() + m.slice(1),
            type: "radio" as const,
            checked: mode === m,
            click: () => setTheme(m),
          })),
        },
        { type: "separator" },
        ...(app.isPackaged ? [] : [{ role: "reload" as const }, { role: "toggleDevTools" as const }]),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "OpenHush",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111110" : "#F9F9F8",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  // Never navigate away from the app (e.g. when a file is dropped outside the drop handler) or open popups.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("close", (e) => {
    if (quitting) return; // already confirmed in before-quit
    if (confirmQuitDuringBatch()) quitting = true;
    else e.preventDefault();
  });
  win.on("closed", () => (win = null));
  void win.loadURL(DEV_URL ?? "app://openhush/index.html");
}

function serveUi() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(UI_DIR, rel);
    if (!isInside(file, UI_DIR)) return new Response("Not found", { status: 404 });
    try {
      await fs.access(file);
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return net.fetch(pathToFileURL(path.join(UI_DIR, "index.html")).toString());
    }
  });
}

function contentSecurityPolicy() {
  const dev = !!DEV_URL;
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self'${dev ? " ws://localhost:* http://localhost:*" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
}

// ------------------------------------------------------------------ lifecycle

app.whenReady().then(async () => {
  if (!app.isPackaged) app.dock?.setIcon(path.join(REPO_ROOT, "build", "icon.png"));
  nativeTheme.themeSource = readPrefs().theme ?? "system";
  buildMenu();
  contentSecurityPolicy();
  serveUi();
  createWindow();
  updater.start();
  try {
    await startEngine();
  } catch (e) {
    log(`engine failed to start: ${e}`);
    win?.webContents.send("engine:event", "engineExit", { message: String(e) });
  }
});

// ⌘Q fires before-quit before any window's close event, so the mid-batch question is asked here.
app.on("before-quit", (e) => {
  if (quitting) return;
  if (!confirmQuitDuringBatch()) {
    e.preventDefault();
    return;
  }
  quitting = true;
  updater.stop();
});
app.on("will-quit", (e) => {
  if (engine) {
    e.preventDefault();
    const eng = engine;
    engine = null;
    void eng.stop().finally(() => app.quit());
  }
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!win) createWindow();
});
