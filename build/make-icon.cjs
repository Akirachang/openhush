// Renders build/icon.svg and build/icon-small.svg to 1024 px PNGs with Electron's own Chromium.
// Run `npm run icon` (this script, then build/make-icns.sh to assemble icon.icns).
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

async function render(win, name) {
  const svg = fs.readFileSync(path.join(__dirname, `${name}.svg`), "utf8");
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, `${name}.png`), img.resize({ width: 1024, height: 1024 }).toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await render(win, "icon");
  await render(win, "icon-small");
  app.quit();
});
