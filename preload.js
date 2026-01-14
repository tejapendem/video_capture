const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getScreenSource: () => ipcRenderer.invoke("get-screen-source"),
  openRegionSelector: () => ipcRenderer.invoke("open-region-selector"),
  saveScreenshot: (data) => ipcRenderer.invoke("save-screenshot", data),
  
  startRecordingStream: () => ipcRenderer.invoke("start-recording-stream"),
  writeRecordingChunk: (chunk) => ipcRenderer.invoke("write-recording-chunk", chunk),
  stopRecordingStream: () => ipcRenderer.invoke("stop-recording-stream"),
  
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  restoreWindow: () => ipcRenderer.invoke("restore-window"),

  // LISTEN FOR WIDGET CLICKS
  onTriggerAction: (callback) => ipcRenderer.on("trigger-action", (event, action) => callback(action))
});