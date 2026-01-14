const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, Tray, Menu } = require("electron");
const { autoUpdater } = require("electron-updater"); // RESTORED
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

// --- AUTO UPDATER SETUP (RESTORED) ---
function setupAutoUpdater() {
  // Optional: Logging
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";

  // Check immediately on startup
  autoUpdater.checkForUpdatesAndNotify();

  // Events
  autoUpdater.on('update-available', () => {
    if (tray) tray.displayBalloon({ title: 'Update Available', content: 'Downloading...' });
  });

  autoUpdater.on('update-downloaded', () => {
    const response = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      title: 'Update Ready',
      message: 'A new version has been downloaded. Restart to install?'
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
    // Fix: Use correct icon path for window title bar
    icon: path.join(__dirname, "build", "icon.png"), 
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile("index.html");

  // CLOSE BEHAVIOR:
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault(); 
      win.hide();
      return false;
    }
  });
}

// --- 2. TRAY ---
function createTray() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() },
    // Manual check button
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() },
    { type: 'separator' },
    { label: 'Quit', click: () => { 
        isQuitting = true; 
        app.quit(); 
      } 
    }
  ]);
  
  tray.setToolTip('Teja Capture Pro');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => win.show());
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

// --- APP LIFECYCLE ---

app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  createWidget();
  setupAutoUpdater(); // Start the updater logic
  
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  }
});

// --- IPC HANDLERS ---

ipcMain.on("widget-snap", () => {
  if (!widgetWin) return;
  const bounds = widgetWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const workArea = display.workArea;
  const gap = 20;

  const corners = [
    { x: workArea.x + gap, y: workArea.y + gap },
    { x: workArea.x + workArea.width - bounds.width - gap, y: workArea.y + gap },
    { x: workArea.x + gap, y: workArea.y + workArea.height - bounds.height - gap },
    { x: workArea.x + workArea.width - bounds.width - gap, y: workArea.y + workArea.height - bounds.height - gap }
  ];

  let best = corners[0];
  let min = Infinity;
  corners.forEach(c => {
    const d = Math.hypot(c.x - bounds.x, c.y - bounds.y);
    if (d < min) { min = d; best = c; }
  });
  widgetWin.setBounds({ x: best.x, y: best.y, width: bounds.width, height: bounds.height }, true);
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
    ? ["-b:v 20000k"] 
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