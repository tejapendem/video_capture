const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, Tray, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");

// --- CRITICAL FIX: FFmpeg Path Logic ---
let ffmpegPath;
if (app.isPackaged) {
  // In production, finding the unpacked binary is tricky. 
  // We point to the node_modules inside the resources folder.
  ffmpegPath = require('ffmpeg-static').replace(
    'app.asar',
    'app.asar.unpacked'
  );
} else {
  // In dev mode
  ffmpegPath = require("ffmpeg-static");
}
ffmpeg.setFfmpegPath(ffmpegPath);
// ----------------------------------------

let win;
let selectorWin;
let widgetWin; 
let tray = null;
let currentWriteStream = null;
let tempFilePath = null;
let isQuitting = false;

// --- AUTO UPDATER ---
function setupAutoUpdater() {
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
}

// --- MAIN WINDOW ---
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 750,
    title: "Teja Capture Pro",
    // Fix Icon path for Prod
    icon: path.join(__dirname, "build", "icon.png"), 
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile("index.html");

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault(); 
      win.hide(); 
      return false;
    }
  });
}

// --- WIDGET (LOGO) ---
function createWidget() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;

  widgetWin = new BrowserWindow({
    width: 160, height: 60,
    x: width - 200, y: height - 150,
    type: 'panel', transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  widgetWin.loadFile("widget.html");
  if (process.platform === 'darwin') {
    widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); 
  } else {
    widgetWin.setVisibleOnAllWorkspaces(true);
  }
}

// --- TRAY ---
function createTray() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { win.show(); win.focus(); } },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip('Teja Capture Pro');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// --- APP LIFECYCLE ---
app.whenReady().then(() => {
  // FORCE DOCK ICON TO SHOW
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  }

  createWindow();
  createWidget();
  createTray();
  setupAutoUpdater();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (win) {
    win.show();
    win.restore();
    win.focus();
  }
});

app.on('before-quit', () => isQuitting = true);

// --- IPC HANDLERS ---

ipcMain.handle("check-for-updates", () => {
  if (!app.isPackaged) return "Cannot update in Dev Mode";
  autoUpdater.checkForUpdates();
  return "Checking...";
});

ipcMain.on("widget-snap", () => {
  if (!widgetWin) return;
  const b = widgetWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const wa = display.workArea;
  const gap = 20;

  const corners = [
    { x: wa.x + gap, y: wa.y + gap },
    { x: wa.x + wa.width - b.width - gap, y: wa.y + gap },
    { x: wa.x + gap, y: wa.y + wa.height - b.height - gap },
    { x: wa.x + wa.width - b.width - gap, y: wa.y + wa.height - b.height - gap }
  ];

  let best = corners[0], min = Infinity;
  corners.forEach(c => {
    const d = Math.hypot(c.x - b.x, c.y - b.y);
    if (d < min) { min = d; best = c; }
  });
  widgetWin.setBounds({ x: best.x, y: best.y, width: b.width, height: b.height }, true);
});

ipcMain.on("widget-action", (e, act) => {
  if (win) win.webContents.send("trigger-action", act);
});

ipcMain.handle("minimize-window", () => win.hide());
ipcMain.handle("restore-window", () => { win.show(); win.restore(); win.focus(); });

ipcMain.handle("get-screen-source", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  return sources[0].id;
});

ipcMain.handle("open-region-selector", async () => {
  return new Promise(resolve => {
    const { width, height } = screen.getPrimaryDisplay().bounds;
    selectorWin = new BrowserWindow({
      width, height, x: 0, y: 0,
      transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
      enableLargerThanScreen: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    selectorWin.loadFile("selector.html");
    if (process.platform === "win32") selectorWin.maximize();
    ipcMain.once("region-selected", (e, r) => { if (selectorWin) selectorWin.close(); resolve(r); });
  });
});

ipcMain.handle("start-recording-stream", async () => {
  try {
    tempFilePath = path.join(app.getPath("temp"), `temp-rec-${Date.now()}.webm`);
    currentWriteStream = fs.createWriteStream(tempFilePath);
    return true;
  } catch (e) { return false; }
});

ipcMain.handle("write-recording-chunk", async (e, chunk) => {
  if (currentWriteStream?.writable) currentWriteStream.write(Buffer.from(chunk));
});

ipcMain.handle("stop-recording-stream", async () => {
  if (currentWriteStream) { await new Promise(r => currentWriteStream.end(r)); currentWriteStream = null; }
  
  if (win) { win.show(); win.restore(); win.focus(); }
  
  if (!tempFilePath || !fs.existsSync(tempFilePath)) return null;
  const stats = fs.statSync(tempFilePath);
  if (stats.size === 0) return "EMPTY";

  const { filePath, canceled } = await dialog.showSaveDialog({
    title: "Save Recording",
    defaultPath: `recording-${Date.now()}.mp4`,
    filters: [{ name: "Video", extensions: ["mp4"] }]
  });

  if (canceled) { try { fs.unlinkSync(tempFilePath); } catch (e) {} return null; }

  let videoCodec = process.platform === "darwin" ? "h264_videotoolbox" : "libx264";
  let outputOptions = process.platform === "darwin" ? ["-b:v 20000k"] : ["-preset ultrafast", "-crf 23", "-pix_fmt yuv420p"];

  return new Promise((resolve) => {
    ffmpeg(tempFilePath).inputFormat("webm")
      .outputOptions([`-c:v ${videoCodec}`, ...outputOptions])
      .on("end", () => { try { fs.unlinkSync(tempFilePath); } catch (e) {} resolve(filePath); })
      .on("error", (e) => { console.error(e); resolve(null); })
      .save(filePath);
  });
});

ipcMain.handle("save-screenshot", async (e, d) => {
  const b64 = d.split(';base64,').pop();
  const { filePath, canceled } = await dialog.showSaveDialog({ title: "Save Screenshot", defaultPath: `screen-${Date.now()}.png` });
  if (!canceled) fs.writeFileSync(filePath, b64, { encoding: 'base64' });
  return filePath;
});