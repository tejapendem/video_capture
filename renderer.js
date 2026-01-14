const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const screenshotBtn = document.getElementById("screenshotBtn");
const status = document.getElementById("status");
const micToggle = document.getElementById("micToggle");
const sysAudioToggle = document.getElementById("sysAudioToggle");
const recordMode = document.getElementById("recordMode");
const fpsSelect = document.getElementById("fpsSelect");

let recorder = null;
let activeStreams = [];
let audioContext = null;
let regionData = null;
let isRecording = false;

startBtn.onclick = prepareAndStart;
stopBtn.onclick = stopRecording;

pauseBtn.onclick = () => {
  if (recorder && recorder.state === "recording") { recorder.pause(); pauseBtn.disabled = true; resumeBtn.disabled = false; status.textContent = "Paused ⏸"; }
};
resumeBtn.onclick = () => {
  if (recorder && recorder.state === "paused") { recorder.resume(); pauseBtn.disabled = false; resumeBtn.disabled = true; status.textContent = "Recording... 🔴"; }
};

async function prepareAndStart() {
  if (recordMode.value === "region") {
    status.textContent = "Select a region...";
    try {
      await window.api.minimizeWindow();
      regionData = await window.api.openRegionSelector();
      await window.api.restoreWindow();
    } catch (err) { regionData = null; }

    if (!regionData) {
      status.textContent = "Selection cancelled.";
      await window.api.restoreWindow();
      return;
    }
  } else {
    regionData = null;
  }
  startRecording();
}

async function startRecording() {
  try {
    status.textContent = "Initializing...";
    const sourceId = await window.api.getScreenSource();
    
    await window.api.minimizeWindow();
    await window.api.startRecordingStream();

    const fps = parseInt(fpsSelect.value) || 30;
    
    const videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 3840, maxHeight: 2160,
          minFrameRate: fps, maxFrameRate: fps
        }
      }
    });

    // AUDIO
    let finalAudioTracks = [];
    if (micToggle.checked || sysAudioToggle.checked) {
      try {
        audioContext = new AudioContext();
        const dest = audioContext.createMediaStreamDestination();
        let audioAdded = false;

        if (micToggle.checked) {
          try {
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (micStream.getAudioTracks().length > 0) {
              audioContext.createMediaStreamSource(micStream).connect(dest);
              activeStreams.push(micStream);
              audioAdded = true;
            }
          } catch (e) { console.warn("Mic Access Denied"); }
        }

        if (sysAudioToggle.checked) {
          try {
            const sysStream = await navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } },
              video: false
            });
            if (sysStream.getAudioTracks().length > 0) {
              audioContext.createMediaStreamSource(sysStream).connect(dest);
              activeStreams.push(sysStream);
              audioAdded = true;
            }
          } catch (e) { console.warn("Sys Audio Access Denied"); }
        }

        if (audioAdded) finalAudioTracks = dest.stream.getAudioTracks();
      } catch (e) { console.error("Audio Context Failed"); }
    }

    // COMBINE
    let finalStream;
    if (regionData) {
      const videoElem = document.createElement('video');
      videoElem.srcObject = videoStream;
      videoElem.muted = true;
      await videoElem.play();

      let attempts = 0;
      while (videoElem.videoWidth === 0 && attempts < 50) { await new Promise(r => setTimeout(r, 50)); attempts++; }

      const streamW = videoElem.videoWidth;
      const streamH = videoElem.videoHeight;
      const scaleX = streamW / regionData.screenWidth;
      const scaleY = streamH / regionData.screenHeight;

      const cutX = Math.floor(regionData.bounds.x * scaleX);
      const cutY = Math.floor(regionData.bounds.y * scaleY);
      const cutW = Math.max(2, Math.floor(regionData.bounds.width * scaleX));
      const cutH = Math.max(2, Math.floor(regionData.bounds.height * scaleY));

      const canvas = document.createElement('canvas');
      canvas.width = cutW;
      canvas.height = cutH;
      const ctx = canvas.getContext('2d', { alpha: false });

      const canvasStream = canvas.captureStream(fps); 
      isRecording = true;

      const draw = () => {
        if (!isRecording) return;
        ctx.drawImage(videoElem, cutX, cutY, cutW, cutH, 0, 0, cutW, cutH);
        requestAnimationFrame(draw);
      };
      draw();

      finalStream = new MediaStream([...canvasStream.getVideoTracks(), ...finalAudioTracks]);
      activeStreams.push(videoStream);
    } else {
      finalStream = new MediaStream([...videoStream.getVideoTracks(), ...finalAudioTracks]);
    }

    // RECORDING - 25 Mbps for Extreme Quality
    recorder = new MediaRecorder(finalStream, {
      mimeType: "video/webm; codecs=vp9",
      videoBitsPerSecond: 25000000 
    });

    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        const buffer = await e.data.arrayBuffer();
        window.api.writeRecordingChunk(new Uint8Array(buffer));
      }
    };

    recorder.onstop = finishRecording;
    recorder.start(500); 
    isRecording = true;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
    status.textContent = "Recording... 🔴";

  } catch (error) {
    console.error(error);
    status.textContent = "Error: " + error.message;
    window.api.restoreWindow();
  }
}

function stopRecording() {
  isRecording = false;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
  if (audioContext) audioContext.close();
}

async function finishRecording() {
  status.textContent = "Finalizing...";
  try {
    await new Promise(r => setTimeout(r, 1000));
    const result = await window.api.stopRecordingStream();
    status.textContent = (result && result !== "EMPTY") ? "Saved ✅" : "Cancelled/Empty";
  } catch (err) {
    status.textContent = "Save Failed";
    window.api.restoreWindow();
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  pauseBtn.disabled = true;
  resumeBtn.disabled = true;
  recorder = null;
}

// SCREENSHOT LOGIC (High Quality Wait)
screenshotBtn.onclick = async () => {
  const originalText = status.textContent;
  status.textContent = "Screenshot...";
  screenshotBtn.disabled = true;

  try {
    await window.api.minimizeWindow(); 

    let rData = null;
    if (recordMode.value === "region") {
      rData = await window.api.openRegionSelector();
      if (!rData) {
        await window.api.restoreWindow();
        status.textContent = "Cancelled";
        screenshotBtn.disabled = false;
        return;
      }
    }

    const sourceId = await window.api.getScreenSource();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160 } }
    });

    const video = document.createElement("video");
    video.srcObject = stream;
    video.play();
    
    // WAIT 1 FULL SECOND for Image to Settle/Focus
    await new Promise(r => setTimeout(r, 1000));
    
    let attempts = 0;
    while (video.videoWidth === 0 && attempts < 50) { await new Promise(r => setTimeout(r, 50)); attempts++; }

    const streamW = video.videoWidth;
    const streamH = video.videoHeight;
    let cutX = 0, cutY = 0, cutW = streamW, cutH = streamH;
    
    if (rData) {
      const scaleX = streamW / rData.screenWidth;
      const scaleY = streamH / rData.screenHeight;
      cutX = Math.floor(rData.bounds.x * scaleX);
      cutY = Math.floor(rData.bounds.y * scaleY);
      cutW = Math.max(2, Math.floor(rData.bounds.width * scaleX));
      cutH = Math.max(2, Math.floor(rData.bounds.height * scaleY));
    }

    const canvas = document.createElement("canvas");
    canvas.width = cutW;
    canvas.height = cutH;
    const ctx = canvas.getContext("2d");
    
    // High Quality Draw
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, cutX, cutY, cutW, cutH, 0, 0, cutW, cutH);

    const base64Data = canvas.toDataURL("image/png", 1.0); // Max Quality PNG
    stream.getTracks().forEach(t => t.stop());
    
    await window.api.saveScreenshot(base64Data);
    status.textContent = "Saved 📸";

  } catch (err) {
    console.error(err);
    status.textContent = "Failed";
    window.api.restoreWindow();
  }
  screenshotBtn.disabled = false;
};

// LISTEN FOR WIDGET
window.api.onTriggerAction((action) => {
  console.log("Received Action:", action);
  
  if (action === 'screenshot') {
    screenshotBtn.click();
  } 
  else if (action === 'record') {
    if (!isRecording) {
      console.log("Starting Record from Widget");
      startBtn.click();
    } else {
      console.log("Stopping Record from Widget");
      stopBtn.click();
    }
  }
});