// Frames the raw captures from capture.mjs into the README images, with Electron's own Chromium.
// Run: npm run readme:assets   (or, after a capture: npx electron build/readme/compose.cjs)
// Writes .github/assets/{banner,screenshot-batch,social-preview,wordmark-dark,wordmark-light}.png
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
const ASSETS = path.join(ROOT, ".github", "assets");
const MEDIA = path.join(ROOT, "ui", "out", "_next", "static", "media");
const url = (p) => pathToFileURL(p).href;

// Dark tokens from ui/app/globals.css
const C = { bg: "#0B0B0A", app: "#111110", panel: "#1A1A19", ink: "#EDEDEA", muted: "#9A9A95", faint: "#3A3A37", red: "#EF5A3C" };
const WAVE = "M33 57 C43.6 30.6 54.2 30.6 63 50 S82.4 69.4 93 43";

/** The app's own bundled fonts (Inter Tight, Geist Mono), so the images match the UI exactly. */
function fontFaces() {
  const dir = path.join(ROOT, "ui", "out", "_next", "static", "chunks");
  const css = fs.readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];
  if (!faces.length) throw new Error("No bundled fonts found. Run `npm run build:ui` first.");
  return faces.map((f) => f.replaceAll("url(../media/", `url(${url(MEDIA)}/`)).join("\n");
}

const mark = (size, { simple = false, ink = C.ink } = {}) => `
  <svg width="${size}" height="${size}" viewBox="0 0 100 100">${simple
    ? `<circle cx="13" cy="57" r="6" fill="${ink}" opacity=".45"/>
       <path d="${WAVE}" fill="none" stroke="${ink}" stroke-width="14" stroke-linecap="round"/>
       <circle cx="33" cy="57" r="9" fill="${C.red}"/>`
    : `<circle cx="6.5" cy="57" r="3.5" fill="${ink}" opacity=".3"/>
       <circle cx="18" cy="57" r="4.5" fill="${ink}" opacity=".55"/>
       <path d="${WAVE}" fill="none" stroke="${ink}" stroke-width="11" stroke-linecap="round"/>
       <circle cx="33" cy="57" r="7" fill="${C.red}"/>`}
  </svg>`;

/** A macOS window around a 1280 x 820 capture. The app hides the title bar, so the traffic lights are drawn in. */
const windowFrame = (img, width) => {
  const s = width / 1280;
  return `
  <div class="win" style="width:${width}px;height:${820 * s}px">
    <img src="${url(path.join(OUT, img))}" style="width:100%;height:100%;display:block">
    <div class="lights" style="transform:scale(${s});transform-origin:0 0">
      <i style="background:#FF5F57"></i><i style="background:#FEBC2E"></i><i style="background:#28C840"></i>
    </div>
  </div>`;
};

const BASE = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; -webkit-font-smoothing: antialiased; }
  body { font-family: "Inter Tight", sans-serif; color: ${C.ink}; }
  .mono { font-family: "Geist Mono", monospace; text-transform: uppercase; letter-spacing: .14em; font-size: 11px; color: ${C.muted}; }
  .stage {
    position: relative; overflow: hidden; border-radius: 22px;
    background:
      radial-gradient(900px 420px at 50% 112%, rgba(239, 90, 60, .10), transparent 70%),
      radial-gradient(1000px 500px at 50% -20%, rgba(255, 255, 255, .05), transparent 70%),
      ${C.bg};
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07);
  }
  .grid {
    position: absolute; inset: 0; pointer-events: none;
    background-image: radial-gradient(rgba(255, 255, 255, .055) 1px, transparent 1px);
    background-size: 22px 22px;
    -webkit-mask-image: radial-gradient(closest-side at 50% 40%, #000, transparent);
  }
  .win {
    position: relative; overflow: hidden; border-radius: 14px;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .9), 0 30px 80px rgba(0, 0, 0, .55), 0 10px 24px rgba(0, 0, 0, .4);
  }
  .win::after { content: ""; position: absolute; inset: 0; border-radius: 14px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); pointer-events: none; }
  .lights { position: absolute; left: 14px; top: 14px; display: flex; gap: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0, 0, 0, .25); }
  .bar { width: 44px; height: 2px; background: ${C.red}; }
`;

const page = (body, css = "") => `<!doctype html><html><head><meta charset="utf-8">
  <style>${fontFaces()}${BASE}${css}</style></head><body>${body}</body></html>`;

/** Hero: wordmark, headline in the app's own type, and the app window fading into the background. */
function banner() {
  const W = 1200, H = 760;
  return {
    W, H,
    html: page(`
    <div class="stage" style="width:${W}px;height:${H}px">
      <div class="grid"></div>
      <div style="position:absolute;left:64px;right:64px;top:44px;display:flex;align-items:center;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:8px">${mark(30, { simple: true })}
          <span style="font-size:19px;font-weight:700;letter-spacing:-.03em">OpenHush</span></span>
        <span class="mono">DeepFilterNet3 &nbsp;·&nbsp; 100% local &nbsp;·&nbsp; MIT</span>
      </div>
      <div style="position:absolute;left:64px;top:122px;display:flex;flex-direction:column;gap:8px">
        <span style="font-size:22px;font-weight:500;letter-spacing:-.03em;color:${C.muted}">AI noise removal for audio and video</span>
        <h1 style="font-size:66px;font-weight:600;line-height:1;letter-spacing:-.045em">Clear voice. Nothing uploaded.</h1>
        <div class="bar" style="margin-top:14px"></div>
      </div>
      <div style="position:absolute;left:64px;top:300px">${windowFrame("preview.png", 1072)}</div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:200px;background:linear-gradient(to bottom, transparent, ${C.bg} 92%)"></div>
    </div>`),
  };
}

/** A full window on the dark stage, for the screenshots further down the README. */
function shot(img) {
  const pad = 56, w = 1100, W = w + pad * 2, H = Math.round((820 * w) / 1280) + pad * 2;
  return {
    W, H,
    html: page(`
    <div class="stage" style="width:${W}px;height:${H}px;padding:${pad}px">
      <div class="grid"></div>
      <div style="position:relative">${windowFrame(img, w)}</div>
    </div>`),
  };
}

/** GitHub's social preview (Settings > General > Social preview): 1280 x 640, no rounded corners. */
function social() {
  const W = 1280, H = 640;
  return {
    W, H,
    html: page(`
    <div class="stage" style="width:${W}px;height:${H}px;border-radius:0">
      <div class="grid"></div>
      <div style="position:absolute;left:80px;top:150px;width:470px;display:flex;flex-direction:column;gap:14px">
        <span style="display:flex;align-items:center;gap:10px;margin-bottom:22px">${mark(44, { simple: true })}
          <span style="font-size:28px;font-weight:700;letter-spacing:-.03em">OpenHush</span></span>
        <h1 style="font-size:54px;font-weight:600;line-height:1.02;letter-spacing:-.045em">Clear voice.<br>Nothing uploaded.</h1>
        <div class="bar" style="margin-top:10px"></div>
        <span style="font-size:20px;font-weight:500;letter-spacing:-.02em;line-height:1.4;color:${C.muted};margin-top:10px">
          Local AI noise removal for audio and video on macOS.</span>
        <span class="mono" style="margin-top:18px">DeepFilterNet3 &nbsp;·&nbsp; 100% local &nbsp;·&nbsp; MIT</span>
      </div>
      <div style="position:absolute;left:600px;top:96px">${windowFrame("preview.png", 900)}</div>
    </div>`),
  };
}

/** The app icon on a dark tile (the mark from build/icon.svg, recoloured for dark mode). */
const tile = (size) => `
  <svg width="${size}" height="${size}" viewBox="0 0 1024 1024">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2A2A28"/><stop offset="1" stop-color="#121211"/></linearGradient></defs>
    <rect x="40" y="40" width="944" height="944" rx="212" fill="url(#bg)"/>
    <rect x="41.5" y="41.5" width="941" height="941" rx="210.5" fill="none" stroke="#FFFFFF" stroke-opacity=".1" stroke-width="3"/>
    <g transform="translate(181 181) scale(6.62)">
      <circle cx="6.5" cy="57" r="3.5" fill="${C.ink}" opacity=".3"/>
      <circle cx="18" cy="57" r="4.5" fill="${C.ink}" opacity=".55"/>
      <path d="${WAVE}" fill="none" stroke="${C.ink}" stroke-width="11" stroke-linecap="round"/>
      <circle cx="33" cy="57" r="7" fill="${C.red}"/>
    </g>
  </svg>`;

/**
 * The README title: icon + "OpenHush" in the app's type, on a transparent background. It's an image because
 * GitHub draws borders around tables and under every <h1>. Light and dark variants are swapped with <picture>.
 */
function lockup(theme) {
  const ink = theme === "dark" ? C.ink : "#111111";
  return {
    W: 600, H: 140, fit: ".lockup",
    html: page(`
    <div class="lockup" style="display:inline-flex;align-items:center;gap:16px;padding:4px 6px 4px 0">
      ${tile(76)}
      <span style="font-size:54px;font-weight:600;letter-spacing:-.045em;line-height:1;color:${ink};padding-bottom:4px">OpenHush</span>
    </div>`),
  };
}

async function render(win, name, { W, H, html, fit }, scale = 2, resizeTo) {
  const file = path.join(OUT, `_${name}.html`);
  fs.writeFileSync(file, html);
  win.setContentSize(W, H);
  await win.loadFile(file);
  await win.webContents.executeJavaScript(
    "Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode())]).then(() => true)");
  await new Promise((r) => setTimeout(r, 300));
  // `fit` crops to one element's box instead of the whole canvas
  const rect = fit
    ? await win.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(fit)}).getBoundingClientRect();
        return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`)
    : { x: 0, y: 0, width: W, height: H };
  let img = await win.webContents.capturePage(rect);
  if (img.getSize().width !== rect.width * scale) throw new Error(`${name}: captured at ${img.getSize().width} px, expected ${rect.width * scale}`);
  if (resizeTo) img = img.resize({ width: resizeTo, quality: "best" });
  fs.writeFileSync(path.join(ASSETS, `${name}.png`), img.toPNG());
  fs.rmSync(file);
  console.log(`${name}.png  ${img.getSize().width} x ${img.getSize().height}`);
}

app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.whenReady().then(async () => {
  for (const f of ["preview.png", "batch.png"]) {
    if (!fs.existsSync(path.join(OUT, f))) throw new Error(`Missing ${f}. Run build/readme/capture.mjs first.`);
  }
  fs.mkdirSync(ASSETS, { recursive: true });
  const win = new BrowserWindow({
    show: false, frame: false, transparent: true, useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: { deviceScaleFactor: 2 } },
  });
  await render(win, "banner", banner());
  await render(win, "screenshot-batch", shot("batch.png"));
  await render(win, "social-preview", social(), 2, 1280);
  await render(win, "wordmark-dark", lockup("dark"));
  await render(win, "wordmark-light", lockup("light"));
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
