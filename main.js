const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, Tray, Menu } = require("electron");
const { autoUpdater } = require("electron-updater"); // NEW
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

let win;
let selectorWin;
let widgetWin; 
let tray = null;
let currentWriteStream = null;
let tempFilePath = null;
let isQuitting = false;

// --- AUTO UPDATER SETUP ---
// This handles the logic for checking GitHub for new versions
function setupAutoUpdater() {
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";

  // Check for updates immediately when app starts
  autoUpdater.checkForUpdatesAndNotify();

  // Listen for update events
  autoUpdater.on('update-available', () => {
    if (tray) tray.displayBalloon({ title: 'Update Available', content: 'Downloading new version...' });
  });

  autoUpdater.on('update-downloaded', () => {
    const response = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['Restart', 'Later'],
      title: 'Update Ready',
      message: 'A new version has been downloaded. Restart now to install?'
    });

    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
}

// --- 1. MAIN WINDOW ---
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 750,
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

// --- 2. TRAY (Updated with Update Check) ---
function createTray() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() },
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() }, // NEW
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  
  tray.setToolTip('Teja Capture Pro');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (win.isVisible()) win.hide(); else win.show();
  });
}

// --- 3. WIDGET ---
function createWidget() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;

  widgetWin = new BrowserWindow({
    width: 160, 
    height: 60,
    x: width - 200, 
    y: height - 150,
    type: 'panel', 
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  widgetWin.loadFile("widget.html");
  
  if (process.platform === 'darwin') {
    widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); 
  } else {
    widgetWin.setVisibleOnAllWorkspaces(true);
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  createWidget();
  setupAutoUpdater(); // Initialize Updater
});

// --- IPC HANDLERS ---

ipcMain.on("widget-snap", () => {
  if (!widgetWin) return;
  const { x, y, width: w, height: h } = widgetWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x, y });
  const { width: sw, height: sh, x: dx, y: dy } = display.workArea;

  const corners = [
    { x: dx + 20, y: dy + 20 },
    { x: dx + sw - w - 20, y: dy + 20 },
    { x: dx + 20, y: dy + sh - h - 20 },
    { x: dx + sw - w - 20, y: dy + sh - h - 20 }
  ];

  let nearest = corners[0];
  let minDist = Infinity;
  corners.forEach(c => {
    const dist = Math.hypot(c.x - x, c.y - y);
    if (dist < minDist) { minDist = dist; nearest = c; }
  });
  widgetWin.setBounds({ x: nearest.x, y: nearest.y, width: w, height: h });
});

ipcMain.on("widget-action", (event, action) => {
  if (win) win.webContents.send("trigger-action", action);
});

ipcMain.handle("minimize-window", () => { if (win) win.hide(); });
ipcMain.handle("restore-window", () => { if (win) { win.show(); win.restore(); } });

ipcMain.handle("get-screen-source", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  return sources[0].id;
});

ipcMain.handle("open-region-selector", async () => {
  return new Promise((resolve) => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;

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
  if (currentWriteStream) {
    await new Promise(r => currentWriteStream.end(r));
    currentWriteStream = null;
  }
  if (win) { win.show(); win.restore(); }
  
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
  let outputOptions = process.platform === "darwin" 
    ? ["-b:v 15000k"] 
    : ["-preset ultrafast", "-crf 23", "-pix_fmt yuv420p"];

  return new Promise((resolve) => {
    ffmpeg(tempFilePath)
      .inputFormat("webm")
      .outputOptions([`-c:v ${videoCodec}`, ...outputOptions])
      .on("end", () => { try { fs.unlinkSync(tempFilePath); } catch (e) {} resolve(filePath); })
      .on("error", () => resolve(null))
      .save(filePath);
  });
});

ipcMain.handle("save-screenshot", async (e, d) => {
  const b64 = d.split(';base64,').pop();
  const { filePath, canceled } = await dialog.showSaveDialog({ title: "Save Screenshot", defaultPath: `screen-${Date.now()}.png` });
  if (!canceled) fs.writeFileSync(filePath, b64, { encoding: 'base64' });
  return filePath;
});