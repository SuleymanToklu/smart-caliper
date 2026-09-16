/**
 * Mezuram — Minimalist Camera Measurement Engine (iOS Measure Style)
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    mode: 'measure', // 'measure', 'pin'
    currentSample: null,
    currentFile: null,
    analysisData: null,

    // Base calibrated image
    image: null,
    imageWidth: 0,
    imageHeight: 0,

    // Metric scale
    ppm: 10.0, // pixels per mm

    // Reference Corners (in image coordinates)
    pinCorners: null, // [ {x, y}, {x, y}, {x, y}, {x, y} ]
    detectedCorners: null,
    activePinIndex: -1,

    // Completed measurements: [ { p1: {x, y}, p2: {x, y}, distance_mm: 48.5 } ]
    measurements: [],
    activePoint1: null, // current pending start point {x, y}
    cursorPoint: null,  // current cursor/touch position {x, y}

    // Canvas view transform
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    startPanX: 0,
    startPanY: 0,

    // Camera
    cameraStream: null,
    facingMode: 'environment',
  };

  // --- DOM Elements ---
  const canvas = document.getElementById('cadCanvas');
  const ctx = canvas.getContext('2d');
  const viewport = document.getElementById('viewport');
  const dropzone = document.getElementById('dropzone');
  const statusBanner = document.getElementById('statusBanner');
  const statusText = document.getElementById('statusText');

  // Camera
  const webcamVideo = document.getElementById('webcamVideo');
  const cameraOverlay = document.getElementById('cameraOverlay');
  const shutterBar = document.getElementById('shutterBar');
  const btnShutter = document.getElementById('btnShutter');
  const btnToggleCamera = document.getElementById('btnToggleCamera');
  const btnCamText = document.getElementById('btnCamText');
  const btnEmptyStartCam = document.getElementById('btnEmptyStartCam');
  const btnEmptyUpload = document.getElementById('btnEmptyUpload');
  const btnEmptyDemo = document.getElementById('btnEmptyDemo');

  // Upload
  const btnUploadTrigger = document.getElementById('btnUploadTrigger');
  const fileUpload = document.getElementById('fileInputUpload');

  // Toolbar
  const btnMeasureMode = document.getElementById('btnMeasureMode');
  const btnPinMode = document.getElementById('btnPinMode');
  const btnClearMeasurements = document.getElementById('btnClearMeasurements');

  // Pin Adjustment Bar
  const pinAdjustBar = document.getElementById('pinAdjustBar');
  const btnApplyPins = document.getElementById('btnApplyPins');
  const btnResetPins = document.getElementById('btnResetPins');
  const btnCancelPins = document.getElementById('btnCancelPins');

  // Reference Standard Select
  const selectRef = document.getElementById('selectReference');

  // Magnifier Loupe
  const magnifierLens = document.getElementById('magnifierLens');
  const lensCanvas = document.getElementById('lensCanvas');
  const lensCtx = lensCanvas.getContext('2d');

  // Loading
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');

  // --- Initialize ---
  function init() {
    setupCanvas();
    setupEventListeners();
    setStatus('Masadaki nesneyi ölçmek için kamerayı açın veya fotoğraf yükleyin.');
  }

  function setupCanvas() {
    resizeCanvas();
    window.addEventListener('resize', () => {
      resizeCanvas();
      render();
    });
  }

  function resizeCanvas() {
    canvas.width = viewport.clientWidth;
    canvas.height = viewport.clientHeight;
  }

  // --- Event Listeners ---
  function setupEventListeners() {
    // Camera toggle
    btnToggleCamera.addEventListener('click', () => {
      if (state.cameraStream) {
        stopCamera();
      } else {
        startCamera();
      }
    });

    if (btnEmptyStartCam) btnEmptyStartCam.addEventListener('click', startCamera);
    if (btnEmptyUpload) btnEmptyUpload.addEventListener('click', () => fileUpload.click());
    if (btnEmptyDemo) btnEmptyDemo.addEventListener('click', () => loadSample('sample_card_inspection.png', 'iso_card'));
    if (btnUploadTrigger) btnUploadTrigger.addEventListener('click', () => fileUpload.click());
    if (fileUpload) fileUpload.addEventListener('change', e => handleFileSelect(e.target.files[0]));

    btnShutter.addEventListener('click', snapCameraFrame);

    // Measure Mode toggle
    btnMeasureMode.addEventListener('click', () => {
      setMode('measure');
    });

    // Pin Alignment toggle
    btnPinMode.addEventListener('click', () => {
      setMode('pin');
    });

    // Clear measurements
    btnClearMeasurements.addEventListener('click', () => {
      state.measurements = [];
      state.activePoint1 = null;
      render();
      setStatus('✓ Ölçümler temizlendi. İki noktaya dokunarak yeni ölçüm yapın.');
    });

    // Pin Action Bar buttons
    btnApplyPins.addEventListener('click', applyPinCalibration);
    btnResetPins.addEventListener('click', resetPinsToDetected);
    btnCancelPins.addEventListener('click', () => setMode('measure'));

    // Reference Standard Change
    selectRef.addEventListener('change', () => {
      if (state.currentSample) {
        loadSample(state.currentSample, selectRef.value, state.pinCorners);
      } else if (state.currentFile) {
        uploadFile(state.currentFile, state.pinCorners);
      }
    });

    // 1-Click Samples
    document.querySelectorAll('.btn-sample-mini').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.cameraStream) stopCamera();
        const sample = btn.dataset.sample;
        const ref = btn.dataset.ref;
        selectRef.value = ref;
        loadSample(sample, ref);
      });
    });

    // Drag & Drop
    ['dragenter', 'dragover'].forEach(name => {
      window.addEventListener(name, e => {
        e.preventDefault();
        e.stopPropagation();
      });
    });
    window.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (state.activePoint1) {
          state.activePoint1 = null;
          state.cursorPoint = null;
          render();
          setStatus('Nokta seçimi iptal edildi.');
        } else if (state.mode === 'pin') {
          setMode('measure');
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (state.measurements.length > 0) {
          state.measurements.pop();
          render();
          setStatus('Son ölçüm geri alındı.');
        }
      }
    });

    // Mouse & Touch Interaction
    setupInteractions();
  }

  function setMode(newMode) {
    state.mode = newMode;
    state.activePoint1 = null;

    btnMeasureMode.classList.toggle('active', newMode === 'measure');
    btnPinMode.classList.toggle('active', newMode === 'pin');

    if (newMode === 'pin') {
      pinAdjustBar.style.display = 'flex';
      setStatus('📍 Kartın 4 köşesini parmağınızla kartın uçlarına sürükleyin.');
    } else {
      pinAdjustBar.style.display = 'none';
      setStatus('📏 Ölçmek istediğiniz nesnenin iki ucuna dokunun.');
    }
    render();
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  // --- Camera Controller ---
  async function startCamera() {
    try {
      showLoading('Kamera başlatılıyor...');
      const constraints = {
        video: {
          facingMode: state.facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      };

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Kamera API bulunamadı. Lütfen sayfayı HTTPS (güvenli bağlantı) üzerinden açtığınızdan emin olun.');
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.cameraStream = stream;
      webcamVideo.srcObject = stream;
      await webcamVideo.play();

      dropzone.style.display = 'none';
      canvas.style.display = 'none';
      webcamVideo.style.display = 'block';
      cameraOverlay.style.display = 'flex';
      shutterBar.style.display = 'flex';

      btnCamText.textContent = 'Durdur';
      btnToggleCamera.classList.add('danger');
      setStatus('📷 Kartı çerçeveye hizalayın ve Yakala butonuna basın.');
    } catch (err) {
      console.error('Camera error:', err);
      setStatus('⚠️ Kamera açılamadı: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
    webcamVideo.srcObject = null;
    webcamVideo.style.display = 'none';
    cameraOverlay.style.display = 'none';
    shutterBar.style.display = 'none';
    canvas.style.display = 'block';

    btnCamText.textContent = 'Kamera';
    btnToggleCamera.classList.remove('danger');

    if (!state.image) {
      dropzone.style.display = 'flex';
    } else {
      render();
    }
  }

  function snapCameraFrame() {
    if (!webcamVideo.videoWidth) return;

    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = webcamVideo.videoWidth;
    snapCanvas.height = webcamVideo.videoHeight;
    const snapCtx = snapCanvas.getContext('2d');
    snapCtx.drawImage(webcamVideo, 0, 0, snapCanvas.width, snapCanvas.height);

    stopCamera();

    snapCanvas.toBlob(blob => {
      uploadFile(blob);
    }, 'image/jpeg', 0.95);
  }

  // --- API & Image Upload ---
  async function loadSample(sampleName, refType, manualCorners = null) {
    state.currentSample = sampleName;
    state.currentFile = null;
    showLoading(`${sampleName} yükleniyor...`);

    const formData = new FormData();
    formData.append('sample_name', sampleName);
    formData.append('ref_type', refType || selectRef.value);
    if (manualCorners) {
      formData.append('manual_corners_json', JSON.stringify(manualCorners));
    }

    try {
      const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      processApiResponse(data);
    } catch (err) {
      console.error(err);
      setStatus('⚠️ Yükleme başarısız: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  async function uploadFile(fileOrBlob, manualCorners = null) {
    if (!fileOrBlob) return;
    state.currentFile = fileOrBlob;
    state.currentSample = null;
    showLoading('Fotoğraf kalibre ediliyor...');

    const formData = new FormData();
    formData.append('file', fileOrBlob, 'measure_snap.jpg');
    formData.append('ref_type', selectRef.value);
    if (manualCorners) {
      formData.append('manual_corners_json', JSON.stringify(manualCorners));
    }

    try {
      const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      processApiResponse(data);
    } catch (err) {
      console.error(err);
      setStatus('⚠️ Analiz hatası: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  function handleFileSelect(file) {
    if (!file) return;
    if (state.cameraStream) stopCamera();
    uploadFile(file);
  }

  function processApiResponse(data) {
    state.analysisData = data;
    state.ppm = data.calibration.pixels_per_mm || 10.0;

    // Detected Reference Corners
    if (data.reference_detected_corners_original) {
      state.detectedCorners = JSON.parse(JSON.stringify(data.reference_detected_corners_original));
      if (!state.pinCorners) {
        state.pinCorners = JSON.parse(JSON.stringify(data.reference_detected_corners_original));
      }
    }

    // Load Image: prefer original_png_b64 for natural, non-warped viewing!
    const img = new Image();
    img.src = data.images.original_png_b64 || data.images.rectified_png_b64;
    img.onload = () => {
      state.image = img;
      state.imageWidth = img.width;
      state.imageHeight = img.height;

      dropzone.style.display = 'none';
      canvas.style.display = 'block';
      fitToScreen();
      render();

      const conf = Math.round(data.calibration.confidence * 100);
      if (conf > 50) {
        setStatus(`✓ Referans Algılandı (%${conf} Doğruluk). Ölçmek istediğiniz 2 noktaya dokunun.`);
      } else {
        setStatus(`ℹ️ Referans otomatik bulunamadı. "Kartı Hizala" butonuna basarak 4 köşeyi ayarlayabilirsiniz.`);
      }
    };
  }

  function applyPinCalibration() {
    if (!state.pinCorners || state.pinCorners.length !== 4) return;
    if (state.currentSample) {
      loadSample(state.currentSample, selectRef.value, state.pinCorners);
    } else if (state.currentFile) {
      uploadFile(state.currentFile, state.pinCorners);
    }
    setMode('measure');
  }

  function resetPinsToDetected() {
    if (state.detectedCorners) {
      state.pinCorners = JSON.parse(JSON.stringify(state.detectedCorners));
      render();
    }
  }

  // --- Canvas Rendering (Apple Measure Style) ---
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!state.image) return;

    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    // 1. Draw Clean Natural Image
    ctx.drawImage(state.image, 0, 0);

    // 2. Draw Reference Target Outline (Card / Coin)
    renderReferenceOutline();

    // 3. Draw Completed Measurements
    state.measurements.forEach(m => {
      drawMeasureLine(m.p1, m.p2, m.distance_mm, false);
    });

    // 4. Draw Active Rubberband Line (While dragging/placing 2nd point)
    if (state.activePoint1 && state.cursorPoint && state.mode === 'measure') {
      const dx = state.cursorPoint.x - state.activePoint1.x;
      const dy = state.cursorPoint.y - state.activePoint1.y;
      const distPx = Math.hypot(dx, dy);
      const liveMm = distPx / state.ppm;
      drawMeasureLine(state.activePoint1, state.cursorPoint, liveMm, true);
    }

    ctx.restore();
  }

  function renderReferenceOutline() {
    if (!state.pinCorners || state.pinCorners.length !== 4) return;
    const pts = state.pinCorners;
    const labels = ['TL', 'TR', 'BR', 'BL'];

    // Draw reference box outline
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();

    if (state.mode === 'pin') {
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 3 / state.zoom;
      ctx.fillStyle = 'rgba(0, 240, 255, 0.12)';
      ctx.fill();
      ctx.stroke();

      // Draw 4 Draggable Pin Handles
      pts.forEach((p, idx) => {
        const isHovered = state.activePinIndex === idx;
        drawPinHandle(p.x, p.y, isHovered ? '#ff0055' : '#00f0ff', labels[idx]);
      });
    } else {
      // Subtle green box showing detected reference
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
      ctx.lineWidth = 2 / state.zoom;
      ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawPinHandle(x, y, color, label) {
    const r = 9 / state.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5 / state.zoom;
    ctx.stroke();

    ctx.font = `bold ${13 / state.zoom}px JetBrains Mono`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 12 / state.zoom, y - 8 / state.zoom);
  }

  function drawMeasureLine(p1, p2, distMm, isLive) {
    // 1. Endpoints Dots
    drawMeasureDot(p1.x, p1.y, isLive);
    drawMeasureDot(p2.x, p2.y, isLive);

    // 2. Line
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = isLive ? '#f59e0b' : '#f59e0b';
    ctx.lineWidth = (isLive ? 3 : 2.5) / state.zoom;
    if (isLive) {
      ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Ticks at endpoints (Caliper Jaws)
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const nx = -dy / len;
      const ny = dx / len;
      const jaw = 12 / state.zoom;

      ctx.beginPath();
      ctx.moveTo(p1.x - nx * jaw, p1.y - ny * jaw);
      ctx.lineTo(p1.x + nx * jaw, p1.y + ny * jaw);
      ctx.moveTo(p2.x - nx * jaw, p2.y - ny * jaw);
      ctx.lineTo(p2.x + nx * jaw, p2.y + ny * jaw);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5 / state.zoom;
      ctx.stroke();
    }

    // 4. Centered Measurement Label Pill (iPhone Measure Style)
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    drawMeasurementBadge(midX, midY, distMm);
  }

  function drawMeasureDot(x, y, isLive) {
    const r = (isLive ? 6 : 5) / state.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3 / state.zoom;
    ctx.stroke();
  }

  function drawMeasurementBadge(x, y, mm) {
    let text = `${mm.toFixed(1)} mm`;
    if (mm >= 50.0) {
      text = `${(mm / 10).toFixed(1)} cm`;
    }

    ctx.font = `bold ${14 / state.zoom}px Outfit, sans-serif`;
    const metrics = ctx.measureText(text);
    const padX = 10 / state.zoom;
    const padY = 5 / state.zoom;
    const boxW = metrics.width + padX * 2;
    const boxH = 22 / state.zoom;
    const radius = 6 / state.zoom;

    const bx = x - boxW / 2;
    const by = y - boxH / 2;

    // Pill background
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, radius);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.stroke();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // --- Mouse & Touch Interactions ---
  function setupInteractions() {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hasMoved = false;

    function getHitPinIndex(imgX, imgY) {
      if (!state.pinCorners || state.mode !== 'pin') return -1;
      const hitRadius = 26 / state.zoom;
      for (let i = 0; i < state.pinCorners.length; i++) {
        const p = state.pinCorners[i];
        if (Math.hypot(p.x - imgX, p.y - imgY) <= hitRadius) {
          return i;
        }
      }
      return -1;
    }

    function updateMagnifier(screenX, screenY, imgX, imgY) {
      if (!state.image) return;

      magnifierLens.style.display = 'block';
      magnifierLens.style.left = `${screenX}px`;
      magnifierLens.style.top = `${screenY}px`;

      lensCtx.clearRect(0, 0, lensCanvas.width, lensCanvas.height);
      const zoomFactor = 2.5;
      const cropW = lensCanvas.width / zoomFactor;
      const cropH = lensCanvas.height / zoomFactor;
      const sx = imgX - cropW / 2;
      const sy = imgY - cropH / 2;

      lensCtx.drawImage(
        state.image,
        sx, sy, cropW, cropH,
        0, 0, lensCanvas.width, lensCanvas.height
      );
    }

    // Mouse Down
    canvas.addEventListener('mousedown', e => {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const imgCoord = screenToImageCoords(screenX, screenY);

      // 1. Check Pin mode drag
      if (state.mode === 'pin') {
        const pinIdx = getHitPinIndex(imgCoord.x, imgCoord.y);
        if (pinIdx !== -1) {
          state.activePinIndex = pinIdx;
          updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
          return;
        }
      }

      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      state.startPanX = state.panX;
      state.startPanY = state.panY;
    });

    // Mouse Move
    window.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const imgCoord = screenToImageCoords(screenX, screenY);

      // Pin Dragging
      if (state.activePinIndex !== -1 && state.pinCorners) {
        state.pinCorners[state.activePinIndex] = { x: imgCoord.x, y: imgCoord.y };
        updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
        render();
        return;
      }

      // Measuring rubberband preview
      if (state.activePoint1 && state.mode === 'measure') {
        state.cursorPoint = imgCoord;
        updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
        render();
      }

      // Canvas Panning
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved = true;
        state.panX = state.startPanX + dx;
        state.panY = state.startPanY + dy;
        render();
      }
    });

    // Mouse Up
    window.addEventListener('mouseup', e => {
      magnifierLens.style.display = 'none';

      if (state.activePinIndex !== -1) {
        state.activePinIndex = -1;
        render();
        return;
      }

      if (!isDragging) return;
      isDragging = false;

      if (!hasMoved) {
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const imgCoord = screenToImageCoords(screenX, screenY);
        handleCanvasTap(imgCoord.x, imgCoord.y);
      }
    });

    // Mouse Wheel Zoom
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 0.85;
      zoomAt(mouseX, mouseY, factor);
    });

    // Touch Handling (Mobile / Tablet)
    let touchStartDist = 0;
    let touchStartZoom = 1;

    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const screenX = t.clientX - rect.left;
        const screenY = t.clientY - rect.top;
        const imgCoord = screenToImageCoords(screenX, screenY);

        if (state.mode === 'pin') {
          const pinIdx = getHitPinIndex(imgCoord.x, imgCoord.y);
          if (pinIdx !== -1) {
            state.activePinIndex = pinIdx;
            updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
            return;
          }
        }

        isDragging = true;
        hasMoved = false;
        dragStartX = t.clientX;
        dragStartY = t.clientY;
        state.startPanX = state.panX;
        state.startPanY = state.panY;
      } else if (e.touches.length === 2) {
        isDragging = false;
        state.activePinIndex = -1;
        magnifierLens.style.display = 'none';
        touchStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        touchStartZoom = state.zoom;
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const screenX = t.clientX - rect.left;
        const screenY = t.clientY - rect.top;
        const imgCoord = screenToImageCoords(screenX, screenY);

        if (state.activePinIndex !== -1 && state.pinCorners) {
          state.pinCorners[state.activePinIndex] = { x: imgCoord.x, y: imgCoord.y };
          updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
          render();
          return;
        }

        if (state.activePoint1 && state.mode === 'measure') {
          state.cursorPoint = imgCoord;
          updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
          render();
        }

        if (isDragging) {
          const dx = t.clientX - dragStartX;
          const dy = t.clientY - dragStartY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            hasMoved = true;
            state.panX = state.startPanX + dx;
            state.panY = state.startPanY + dy;
            render();
          }
        }
      } else if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (touchStartDist > 0) {
          state.zoom = Math.min(Math.max(0.1, touchStartZoom * (dist / touchStartDist)), 8.0);
          render();
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
      magnifierLens.style.display = 'none';

      if (state.activePinIndex !== -1) {
        state.activePinIndex = -1;
        render();
        return;
      }

      if (isDragging && !hasMoved && e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const rect = canvas.getBoundingClientRect();
        const screenX = t.clientX - rect.left;
        const screenY = t.clientY - rect.top;
        const imgCoord = screenToImageCoords(screenX, screenY);
        handleCanvasTap(imgCoord.x, imgCoord.y);
      }
      isDragging = false;
    });
  }

  // --- Two-Point Measure Logic (Mezuram Core) ---
  function handleCanvasTap(imgX, imgY) {
    if (state.mode !== 'measure') return;

    if (!state.activePoint1) {
      // First point placed!
      state.activePoint1 = { x: imgX, y: imgY };
      state.cursorPoint = { x: imgX, y: imgY };
      setStatus('📍 1. Nokta seçildi. Şimdi 2. noktaya dokunun.');
      render();
    } else {
      // Second point placed! Complete the measurement!
      const p1 = state.activePoint1;
      const p2 = { x: imgX, y: imgY };
      const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const distMm = distPx / state.ppm;

      state.measurements.push({
        p1: p1,
        p2: p2,
        distance_mm: distMm,
      });

      state.activePoint1 = null;
      state.cursorPoint = null;

      const formatted = distMm >= 50 ? `${(distMm / 10).toFixed(2)} cm` : `${distMm.toFixed(1)} mm`;
      setStatus(`✓ Ölçüm: ${formatted} — Başka bir şey ölçmek için tekrar dokunun.`);
      render();
    }
  }

  // --- Coordinate & Zoom Math ---
  function screenToImageCoords(screenX, screenY) {
    const x = (screenX - state.panX) / state.zoom;
    const y = (screenY - state.panY) / state.zoom;
    return { x, y };
  }

  function zoomAt(screenX, screenY, factor) {
    const newZoom = Math.min(Math.max(0.1, state.zoom * factor), 8.0);
    state.panX = screenX - (screenX - state.panX) * (newZoom / state.zoom);
    state.panY = screenY - (screenY - state.panY) * (newZoom / state.zoom);
    state.zoom = newZoom;
    render();
  }

  function fitToScreen() {
    if (!state.image) return;
    const scaleX = (canvas.width - 40) / state.imageWidth;
    const scaleY = (canvas.height - 40) / state.imageHeight;
    state.zoom = Math.min(scaleX, scaleY, 1.2);
    state.panX = (canvas.width - state.imageWidth * state.zoom) / 2;
    state.panY = (canvas.height - state.imageHeight * state.zoom) / 2;
    render();
  }

  function showLoading(msg) {
    loadingText.textContent = msg || 'İşleniyor...';
    loadingOverlay.style.display = 'flex';
  }

  function hideLoading() {
    loadingOverlay.style.display = 'none';
  }

  // Run on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();
