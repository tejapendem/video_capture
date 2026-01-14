const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const screenshotBtn = document.getElementById("screenshotBtn");
const status = document.getElementById("status");
const overlay = document.getElementById("overlay"); // New
const progressBar = document.getElementById("progressBar"); // New
const micToggle = document.getElementById("micToggle");
const sysAudioToggle = document.getElementById("sysAudioToggle");
const recordMode = document.getElementById("recordMode");
const fpsSelect = document.getElementById("fpsSelect");
const updateBtn = document.getElementById("updateBtn"); // New

let recorder = null;
let activeStreams = [];
let audioContext = null;
let regionData = null;
let isRecording = false;

// --- EVENT LISTENERS ---
startBtn.onclick = prepareAndStart;
stopBtn.onclick = stopRecording;

pauseBtn.onclick = () => {
  if (recorder && recorder.state === "recording") {
    recorder.pause();
    updateUIState('paused');
  }
};

resumeBtn.onclick = () => {
  if (recorder && recorder.state === "paused") {
    recorder.resume();
    updateUIState('recording');
  }
};

// Update Check Logic
if (updateBtn) {
  updateBtn.onclick = async () => {
    updateBtn.textContent = "Checking...";
    updateBtn.disabled = true;
    const result = await window.api.checkForUpdates();
    // Reset button after 5 seconds
    setTimeout(() => {
      updateBtn.textContent = "🔄 Check for Updates";
      updateBtn.disabled = false;
    }, 5000);
  };
}

// --- MAIN FUNCTIONS ---

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

    // AUDIO SETUP
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

    // COMBINE & DRAW
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

    // RECORDING START
    recorder = new MediaRecorder(finalStream, {
      mimeType: "video/webm; codecs=vp9",
      videoBitsPerSecond: 25000000 
    });

    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        window.api.writeRecordingChunk(new Uint8Array(await e.data.arrayBuffer()));
      }
    };

    recorder.onstop = finishRecording;
    recorder.start(500); 
    isRecording = true;
    updateUIState('recording');

  } catch (error) {
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
  // SHOW OVERLAY & START PROGRESS
  if (overlay && progressBar) {
    overlay.style.display = "flex";
    progressBar.style.width = "0%";
    
    // Simulate progress while saving
    let progress = 0;
    const interval = setInterval(() => {
      if (progress < 90) {
        progress += Math.random() * 10;
        progressBar.style.width = progress + "%";
      }
    }, 100);

    try {
      await new Promise(r => setTimeout(r, 1000)); // Ensure flush
      const result = await window.api.stopRecordingStream();
      
      clearInterval(interval);
      progressBar.style.width = "100%"; // Finish bar
      
      setTimeout(() => {
        overlay.style.display = "none";
        status.textContent = (result && result !== "EMPTY") ? "Saved Successfully ✅" : "Cancelled/Empty";
      }, 500);

    } catch (err) {
      clearInterval(interval);
      overlay.style.display = "none";
      status.textContent = "Save Failed ❌";
      window.api.restoreWindow();
    }
  } else {
    // Fallback if overlay elements missing
    const result = await window.api.stopRecordingStream();
    status.textContent = (result && result !== "EMPTY") ? "Saved ✅" : "Cancelled";
  }

  updateUIState('idle');
  recorder = null;
}

// Helper for Professional Button States
function updateUIState(state) {
  if (state === 'recording') {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
    status.textContent = "Recording... 🔴";
    status.style.color = "#ef476f";
  } else if (state === 'paused') {
    pauseBtn.disabled = true;
    resumeBtn.disabled = false;
    status.textContent = "Paused ⏸";
    status.style.color = "#ffd166";
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    status.textContent = "Ready to Record";
    status.style.color = "#a0a0a0";
  }
}

// SCREENSHOT LOGIC
screenshotBtn.onclick = async () => {
  const originalText = status.textContent;
  status.textContent = "Taking Screenshot...";
  screenshotBtn.disabled = true;

  try {
    await window.api.minimizeWindow(); 

    let rData = null;
    if (recordMode.value === "region") {
      rData = await window.api.openRegionSelector();
      if (!rData) {
        await window.api.restoreWindow();
        status.textContent = originalText;
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
    
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, cutX, cutY, cutW, cutH, 0, 0, cutW, cutH);

    const base64Data = canvas.toDataURL("image/png", 1.0);
    stream.getTracks().forEach(t => t.stop());
    
    await window.api.saveScreenshot(base64Data);
    status.textContent = "Saved 📸";
    setTimeout(() => status.textContent = "Ready to Record", 2000);

  } catch (err) {
    status.textContent = "Failed";
    window.api.restoreWindow();
  }
  screenshotBtn.disabled = false;
};

// WIDGET LISTENER
window.api.onTriggerAction((action) => {
  if (action === 'screenshot') {
    screenshotBtn.click();
  } 
  else if (action === 'record') {
    if (!isRecording) {
      startBtn.click();
    } else {
      stopBtn.click();
    }
  }
});