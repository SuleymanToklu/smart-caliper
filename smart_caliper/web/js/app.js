/**
 * SmartCaliper — Client-side CAD Canvas, Metrology Engine & Live Camera
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    mode: 'auto', // 'auto', 'pin', 'caliper', 'circle'
    viewMode: 'cad', // 'cad', 'orig'
    currentSample: null,
    currentFile: null,
    analysisData: null,
    
    // Images
    cadImage: null,
    origImage: null,
    rectifiedImage: null,
    
    // Calibration pins (in original image coordinates)
    pinCorners: null, // [ {x, y}, {x, y}, {x, y}, {x, y} ]
    detectedCorners: null,
    activePinIndex: -1,

    // Metrics
    ppm: 10.0,
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    startPanX: 0,
    startPanY: 0,
    
    // Measurement tools
    caliperPoints: [], // [ {x, y}, {x, y} ]
    circlePoints: [],  // [ {x, y}, {x, y}, {x, y} ]

    // Live Camera
    cameraStream: null,
    facingMode: 'environment', // 'environment' (back) or 'user' (front/webcam)
  };

  // --- DOM Elements ---
  const canvas = document.getElementById('cadCanvas');
  const ctx = canvas.getContext('2d');
  const canvasWrapper = document.getElementById('canvasWrapper');
  const dropzone = document.getElementById('dropzone');
  
  // Camera Elements
  const webcamVideo = document.getElementById('webcamVideo');
  const cameraHud = document.getElementById('cameraHud');
  const btnToggleCamera = document.getElementById('btnToggleCamera');
  const btnCamText = document.getElementById('btnCamText');
  const btnFlipCam = document.getElementById('btnFlipCam');
  const btnCloseCam = document.getElementById('btnCloseCam');
  const btnShutter = document.getElementById('btnShutter');
  const btnEmptyStartCam = document.getElementById('btnEmptyStartCam');
  const btnEmptyUpload = document.getElementById('btnEmptyUpload');

  // File Upload Elements
  const btnUploadTrigger = document.getElementById('btnUploadTrigger');
  const fileUpload = document.getElementById('fileInputUpload');

  // UI Panels
  const caliperHud = document.getElementById('caliperHud');
  const hudValue = document.getElementById('hudValue');
  const hudSub = document.getElementById('hudSub');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  const magnifierLens = document.getElementById('magnifierLens');
  const lensCanvas = document.getElementById('lensCanvas');
  const lensCtx = lensCanvas.getContext('2d');
  const pinBanner = document.getElementById('pinBanner');
  const btnApplyPins = document.getElementById('btnApplyPins');
  const btnResetPins = document.getElementById('btnResetPins');

  // Metrology Controls
  const selectRef = document.getElementById('selectReference');
  const customDimsRow = document.getElementById('customDimsRow');
  const customWidth = document.getElementById('customWidth');
  const customHeight = document.getElementById('customHeight');
  const nomLength = document.getElementById('nomLength');
  const tolLength = document.getElementById('tolLength');
  const nomWidth = document.getElementById('nomWidth');
  const tolWidth = document.getElementById('tolWidth');
  const btnReanalyze = document.getElementById('btnReanalyze');

  // Stats & Header Controls
  const statScale = document.getElementById('statScale');
  const statResolution = document.getElementById('statResolution');
  const statConfidence = document.getElementById('statConfidence');
  const statMode = document.getElementById('currentModeLabel');
  const objCount = document.getElementById('objCount');
  const resultsList = document.getElementById('resultsList');
  const qaBadge = document.getElementById('qaBadge');

  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomFit = document.getElementById('btnZoomFit');
  const btnToggleCad = document.getElementById('btnToggleCad');
  const btnDownloadCad = document.getElementById('btnDownloadCad');
  const btnExportJson = document.getElementById('btnExportJson');

  // --- Initialization ---
  function init() {
    setupEventListeners();
    setupCanvas();
    // Pre-load default sample on launch
    setTimeout(() => {
      loadSample('sample_card_inspection.png', 'iso_card');
    }, 300);
  }

  function setupCanvas() {
    resizeCanvas();
    window.addEventListener('resize', () => {
      resizeCanvas();
      render();
    });
  }

  function resizeCanvas() {
    canvas.width = canvasWrapper.clientWidth;
    canvas.height = canvasWrapper.clientHeight;
  }

  // --- Event Listeners ---
  function setupEventListeners() {
    // Mode switcher (Auto, Pin, Caliper, Circle)
    document.querySelectorAll('#modePills .pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#modePills .pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        state.caliperPoints = [];
        state.circlePoints = [];
        statMode.textContent = btn.textContent.trim();
        caliperHud.style.display = 'none';

        if (state.mode === 'pin') {
          // Force original photo view when aligning pins
          state.viewMode = 'orig';
          btnToggleCad.textContent = '🖼️ Original Photo';
          btnToggleCad.classList.remove('active');
          pinBanner.style.display = 'flex';
        } else {
          pinBanner.style.display = 'none';
        }

        render();
      });
    });

    // Camera buttons
    btnToggleCamera.addEventListener('click', () => {
      if (state.cameraStream) {
        stopCamera();
      } else {
        startCamera();
      }
    });

    btnEmptyStartCam.addEventListener('click', startCamera);
    btnEmptyUpload.addEventListener('click', () => fileUpload.click());
    btnUploadTrigger.addEventListener('click', () => fileUpload.click());
    fileUpload.addEventListener('change', e => handleFileSelect(e.target.files[0]));

    btnFlipCam.addEventListener('click', flipCamera);
    btnCloseCam.addEventListener('click', stopCamera);
    btnShutter.addEventListener('click', snapCameraFrame);

    // Pin Alignment Actions
    btnApplyPins.addEventListener('click', applyPinCalibration);
    btnResetPins.addEventListener('click', resetPinsToDetected);

    // Sample buttons
    document.querySelectorAll('.btn-sample').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.cameraStream) stopCamera();
        const sample = btn.dataset.sample;
        const ref = btn.dataset.ref;
        selectRef.value = ref;
        loadSample(sample, ref);
      });
    });

    // Reference Select
    selectRef.addEventListener('change', () => {
      customDimsRow.style.display = selectRef.value === 'custom_rect' ? 'flex' : 'none';
    });

    // Reanalyze
    btnReanalyze.addEventListener('click', () => {
      if (state.currentSample) {
        loadSample(state.currentSample, selectRef.value, state.pinCorners);
      } else if (state.currentFile) {
        uploadFile(state.currentFile, state.pinCorners);
      }
    });

    // Zoom Controls
    btnZoomIn.addEventListener('click', () => zoomBy(1.2));
    btnZoomOut.addEventListener('click', () => zoomBy(0.8));
    btnZoomFit.addEventListener('click', fitToScreen);

    // Toggle CAD vs Original View
    btnToggleCad.addEventListener('click', () => {
      if (state.viewMode === 'cad') {
        state.viewMode = 'orig';
        btnToggleCad.textContent = '🖼️ Original Photo';
        btnToggleCad.classList.remove('active');
      } else {
        state.viewMode = 'cad';
        btnToggleCad.textContent = '📐 CAD Blueprint';
        btnToggleCad.classList.add('active');
        if (state.mode === 'pin') {
          // Switch back to auto mode if user leaves orig view
          setMode('auto');
        }
      }
      fitToScreen();
      render();
    });

    // Exports
    btnDownloadCad.addEventListener('click', downloadCadImage);
    btnExportJson.addEventListener('click', exportJsonData);

    // Mouse & Touch Interactions
    setupCanvasInteractions();
  }

  function setMode(modeName) {
    document.querySelectorAll('#modePills .pill-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === modeName);
    });
    state.mode = modeName;
    statMode.textContent = modeName.toUpperCase();
    pinBanner.style.display = modeName === 'pin' ? 'flex' : 'none';
    render();
  }

  // --- Live Camera Controller ---
  async function startCamera() {
    try {
      showLoading('Accessing camera...');
      const constraints = {
        video: {
          facingMode: state.facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.cameraStream = stream;
      webcamVideo.srcObject = stream;
      await webcamVideo.play();

      dropzone.style.display = 'none';
      canvas.style.display = 'none';
      webcamVideo.style.display = 'block';
      cameraHud.style.display = 'flex';
      btnCamText.textContent = 'Stop Camera';
      btnToggleCamera.classList.add('btn-danger');
    } catch (err) {
      console.error('Camera access error:', err);
      alert('Camera access denied or unavailable: ' + err.message + '\nEnsure you are using HTTPS or localhost.');
    } finally {
      hideLoading();
    }
  }

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(track => track.stop());
      state.cameraStream = null;
    }
    webcamVideo.srcObject = null;
    webcamVideo.style.display = 'none';
    cameraHud.style.display = 'none';
    canvas.style.display = 'block';
    btnCamText.textContent = 'Live Camera';
    btnToggleCamera.classList.remove('btn-danger');

    if (!state.cadImage && !state.origImage) {
      dropzone.style.display = 'flex';
    } else {
      render();
    }
  }

  async function flipCamera() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(track => track.stop());
      state.cameraStream = null;
    }
    await startCamera();
  }

  function snapCameraFrame() {
    if (!webcamVideo.videoWidth) return;

    // Capture current video frame on an offscreen canvas
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

  // --- API Requests ---
  async function loadSample(sampleName, refType, manualCorners = null) {
    state.currentSample = sampleName;
    state.currentFile = null;
    showLoading(`Analyzing ${sampleName}...`);

    const formData = new FormData();
    formData.append('sample_name', sampleName);
    formData.append('ref_type', refType || selectRef.value);
    if (manualCorners) {
      formData.append('manual_corners_json', JSON.stringify(manualCorners));
    }
    appendToleranceToForm(formData);

    try {
      const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      processAnalysisResponse(data);
    } catch (err) {
      console.error(err);
      alert('Analysis failed: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  async function uploadFile(fileOrBlob, manualCorners = null) {
    if (!fileOrBlob) return;
    state.currentFile = fileOrBlob;
    state.currentSample = null;
    showLoading('Processing with sub-pixel CV...');

    const formData = new FormData();
    formData.append('file', fileOrBlob, 'capture.jpg');
    formData.append('ref_type', selectRef.value);
    if (selectRef.value === 'custom_rect') {
      formData.append('custom_width_mm', customWidth.value);
      formData.append('custom_height_mm', customHeight.value);
    }
    if (manualCorners) {
      formData.append('manual_corners_json', JSON.stringify(manualCorners));
    }
    appendToleranceToForm(formData);

    try {
      const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      processAnalysisResponse(data);
    } catch (err) {
      console.error(err);
      alert('Inspection failed: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  function handleFileSelect(file) {
    if (!file) return;
    if (state.cameraStream) stopCamera();
    uploadFile(file);
  }

  function appendToleranceToForm(formData) {
    if (nomLength.value) formData.append('nominal_length', nomLength.value);
    if (tolLength.value) formData.append('tol_length', tolLength.value);
    if (nomWidth.value) formData.append('nominal_width', nomWidth.value);
    if (tolWidth.value) formData.append('tol_width', tolWidth.value);
  }

  function processAnalysisResponse(data) {
    state.analysisData = data;
    state.ppm = data.calibration.pixels_per_mm;

    // Store corners
    if (data.reference_detected_corners_original) {
      state.detectedCorners = JSON.parse(JSON.stringify(data.reference_detected_corners_original));
      state.pinCorners = JSON.parse(JSON.stringify(data.reference_detected_corners_original));
    }

    // Load Images
    let loadedCount = 0;
    const checkAllLoaded = () => {
      loadedCount++;
      if (loadedCount >= 2) {
        dropzone.style.display = 'none';
        canvas.style.display = 'block';
        fitToScreen();
        render();
      }
    };

    const imgCad = new Image();
    imgCad.src = data.images.cad_annotated_png_b64;
    imgCad.onload = () => {
      state.cadImage = imgCad;
      checkAllLoaded();
    };

    const imgOrig = new Image();
    imgOrig.src = data.images.original_png_b64 || data.images.rectified_png_b64;
    imgOrig.onload = () => {
      state.origImage = imgOrig;
      state.rawImage = imgOrig;
      checkAllLoaded();
    };

    // Update Stats Footer
    statScale.innerHTML = `Scale: <strong>${data.calibration.pixels_per_mm.toFixed(2)} px/mm</strong>`;
    statResolution.innerHTML = `Resolution: <strong>${(data.calibration.resolution_mm_per_pixel * 1000).toFixed(1)} µm/px</strong>`;
    statConfidence.innerHTML = `Confidence: <strong>${(data.calibration.confidence * 100).toFixed(0)}%</strong>`;

    // Update Object Count & Results
    objCount.textContent = data.objects_count;
    renderResultsList(data.measurements);
  }

  function applyPinCalibration() {
    if (!state.pinCorners || state.pinCorners.length !== 4) return;
    if (state.currentSample) {
      loadSample(state.currentSample, selectRef.value, state.pinCorners);
    } else if (state.currentFile) {
      uploadFile(state.currentFile, state.pinCorners);
    }
  }

  function resetPinsToDetected() {
    if (state.detectedCorners) {
      state.pinCorners = JSON.parse(JSON.stringify(state.detectedCorners));
      render();
    }
  }

  function renderResultsList(measurements) {
    resultsList.innerHTML = '';
    if (!measurements || measurements.length === 0) {
      resultsList.innerHTML = '<div class="empty-hint">No parts detected. Tap Caliper to measure point-to-point!</div>';
      qaBadge.style.display = 'none';
      return;
    }

    let hasPass = false;
    let hasFail = false;

    measurements.forEach(m => {
      const item = document.createElement('div');
      item.className = 'result-item';

      let qaHtml = '';
      if (m.qa_inspection) {
        if (m.qa_inspection.passed) {
          qaHtml = `<span class="badge-qa pass">PASS</span>`;
          hasPass = true;
        } else {
          qaHtml = `<span class="badge-qa fail">FAIL</span>`;
          hasFail = true;
        }
      }

      const dim = m.dimensions_mm;
      const circ = m.circle_metrics;

      item.innerHTML = `
        <div class="result-top">
          <span class="part-id">PART #${m.id}</span>
          ${qaHtml}
        </div>
        <div class="dim-row">
          <span class="dim-label">Length × Width:</span>
          <span class="dim-val">${dim.length.toFixed(2)} × ${dim.width.toFixed(2)} mm</span>
        </div>
        ${circ.is_circular ? `
        <div class="dim-row">
          <span class="dim-label">Diameter (Ø):</span>
          <span class="dim-val" style="color:var(--accent-cyan);">Ø ${circ.diameter_mm.toFixed(2)} mm</span>
        </div>` : ''}
        <div class="dim-row">
          <span class="dim-label">Surface Area:</span>
          <span class="dim-val">${m.area_mm2.toFixed(1)} mm²</span>
        </div>
      `;
      resultsList.appendChild(item);
    });

    if (hasFail) {
      qaBadge.style.display = 'block';
      qaBadge.className = 'qa-badge fail';
      qaBadge.textContent = 'QA: REJECTED';
    } else if (hasPass) {
      qaBadge.style.display = 'block';
      qaBadge.className = 'qa-badge pass';
      qaBadge.textContent = 'QA: ACCEPTED';
    } else {
      qaBadge.style.display = 'none';
    }
  }

  // --- Canvas Rendering ---
  function getActiveImage() {
    if (state.viewMode === 'orig') {
      return state.origImage || state.cadImage;
    }
    return state.cadImage || state.origImage;
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const activeImg = getActiveImage();
    if (!activeImg) return;

    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    // Draw active image (CAD Blueprint or Original Photo)
    ctx.drawImage(activeImg, 0, 0);

    // If in original photo view, draw the reference corners outline
    if (state.viewMode === 'orig' && state.pinCorners && state.pinCorners.length === 4) {
      renderReferenceCorners();
    }

    // Draw active caliper tool overlay
    if (state.mode === 'caliper') {
      renderCaliperTool();
    } else if (state.mode === 'circle') {
      renderCircleTool();
    }

    ctx.restore();
  }

  function renderReferenceCorners() {
    const pts = state.pinCorners;
    const labels = ['TL', 'TR', 'BR', 'BL'];

    // Draw bounding polygon connecting 4 corners
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = state.mode === 'pin' ? '#00f0ff' : 'rgba(0, 240, 255, 0.4)';
    ctx.lineWidth = 2.5 / state.zoom;
    ctx.setLineDash(state.mode === 'pin' ? [] : [6 / state.zoom, 4 / state.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Fill polygon lightly
    ctx.fillStyle = 'rgba(0, 240, 255, 0.08)';
    ctx.fill();

    // If in pin mode, draw interactive drag handles
    if (state.mode === 'pin') {
      pts.forEach((p, idx) => {
        const isHovered = state.activePinIndex === idx;
        drawPinHandle(p.x, p.y, isHovered ? '#ff0055' : '#00f0ff', labels[idx]);
      });
    }
  }

  function drawPinHandle(x, y, color, label) {
    const r = 8 / state.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 / state.zoom;
    ctx.stroke();

    // Label tag
    ctx.font = `bold ${13 / state.zoom}px JetBrains Mono`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 12 / state.zoom, y - 8 / state.zoom);
  }

  function renderCaliperTool() {
    const pts = state.caliperPoints;
    if (pts.length === 0) return;

    drawPointHandle(pts[0].x, pts[0].y, '#f59e0b', 'P1');

    if (pts.length === 2) {
      const p1 = pts[0];
      const p2 = pts[1];

      drawPointHandle(p2.x, p2.y, '#f59e0b', 'P2');

      // Caliper measurement line
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5 / state.zoom;
      ctx.setLineDash([5 / state.zoom, 5 / state.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Caliper jaws
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const nx = -dy / len;
        const ny = dx / len;
        const jawLen = 16 / state.zoom;

        // Jaw at p1
        ctx.beginPath();
        ctx.moveTo(p1.x - nx * jawLen, p1.y - ny * jawLen);
        ctx.lineTo(p1.x + nx * jawLen, p1.y + ny * jawLen);
        // Jaw at p2
        ctx.moveTo(p2.x - nx * jawLen, p2.y - ny * jawLen);
        ctx.lineTo(p2.x + nx * jawLen, p2.y + ny * jawLen);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3 / state.zoom;
        ctx.stroke();
      }
    }
  }

  function renderCircleTool() {
    const pts = state.circlePoints;
    pts.forEach((p, idx) => {
      drawPointHandle(p.x, p.y, '#00f0ff', `#${idx + 1}`);
    });

    if (pts.length === 3) {
      const circle = getThreePointCircle(pts[0], pts[1], pts[2]);
      if (circle) {
        ctx.beginPath();
        ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5 / state.zoom;
        ctx.stroke();

        const cs = 10 / state.zoom;
        ctx.beginPath();
        ctx.moveTo(circle.x - cs, circle.y);
        ctx.lineTo(circle.x + cs, circle.y);
        ctx.moveTo(circle.x, circle.y - cs);
        ctx.lineTo(circle.x, circle.y + cs);
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2 / state.zoom;
        ctx.stroke();
      }
    }
  }

  function drawPointHandle(x, y, color, label) {
    const r = 6 / state.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2 / state.zoom;
    ctx.stroke();

    if (label) {
      ctx.font = `${12 / state.zoom}px JetBrains Mono`;
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 8 / state.zoom, y - 6 / state.zoom);
    }
  }

  function getThreePointCircle(p1, p2, p3) {
    const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
    if (Math.abs(d) < 1e-6) return null;

    const ux = ((p1.x * p1.x + p1.y * p1.y) * (p2.y - p3.y) + (p2.x * p2.x + p2.y * p2.y) * (p3.y - p1.y) + (p3.x * p3.x + p3.y * p3.y) * (p1.y - p2.y)) / d;
    const uy = ((p1.x * p1.x + p1.y * p1.y) * (p3.x - p2.x) + (p2.x * p2.x + p2.y * p2.y) * (p1.x - p3.x) + (p3.x * p3.x + p3.y * p3.y) * (p2.x - p1.x)) / d;
    const r = Math.hypot(p1.x - ux, p1.y - uy);
    return { x: ux, y: uy, r };
  }

  // --- Mouse & Touch Handlers ---
  function setupCanvasInteractions() {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hasMoved = false;

    // Pin dragging
    function getHitPinIndex(imgX, imgY) {
      if (!state.pinCorners || state.mode !== 'pin') return -1;
      const hitRadius = 24 / state.zoom; // comfortable touch target
      for (let i = 0; i < state.pinCorners.length; i++) {
        const p = state.pinCorners[i];
        if (Math.hypot(p.x - imgX, p.y - imgY) <= hitRadius) {
          return i;
        }
      }
      return -1;
    }

    function updateMagnifier(screenX, screenY, imgX, imgY) {
      const activeImg = getActiveImage();
      if (!activeImg) return;

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
        activeImg,
        sx, sy, cropW, cropH,
        0, 0, lensCanvas.width, lensCanvas.height
      );
    }

    canvas.addEventListener('mousedown', e => {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const imgCoord = screenToImageCoords(screenX, screenY);

      // Check if clicked on a pin in pin mode
      const pinIdx = getHitPinIndex(imgCoord.x, imgCoord.y);
      if (pinIdx !== -1) {
        state.activePinIndex = pinIdx;
        updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
        return;
      }

      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      state.startPanX = state.panX;
      state.startPanY = state.panY;
    });

    window.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const imgCoord = screenToImageCoords(screenX, screenY);

      // Handle Pin Drag
      if (state.activePinIndex !== -1 && state.pinCorners) {
        state.pinCorners[state.activePinIndex] = { x: imgCoord.x, y: imgCoord.y };
        updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
        render();
        return;
      }

      // Handle Canvas Pan
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

    window.addEventListener('mouseup', e => {
      if (state.activePinIndex !== -1) {
        state.activePinIndex = -1;
        magnifierLens.style.display = 'none';
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
        handleCanvasClick(imgCoord.x, imgCoord.y);
      }
    });

    // Mouse wheel zoom
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 0.85;
      zoomAt(mouseX, mouseY, factor);
    });

    // Touch Support
    let touchStartDist = 0;
    let touchStartZoom = 1;

    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const screenX = t.clientX - rect.left;
        const screenY = t.clientY - rect.top;
        const imgCoord = screenToImageCoords(screenX, screenY);

        const pinIdx = getHitPinIndex(imgCoord.x, imgCoord.y);
        if (pinIdx !== -1) {
          state.activePinIndex = pinIdx;
          updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
          return;
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
      if (state.activePinIndex !== -1) {
        state.activePinIndex = -1;
        magnifierLens.style.display = 'none';
        render();
        return;
      }

      if (isDragging && !hasMoved && e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const rect = canvas.getBoundingClientRect();
        const screenX = t.clientX - rect.left;
        const screenY = t.clientY - rect.top;
        const imgCoord = screenToImageCoords(screenX, screenY);
        handleCanvasClick(imgCoord.x, imgCoord.y);
      }
      isDragging = false;
    });
  }

  function handleCanvasClick(imgX, imgY) {
    if (state.mode === 'caliper') {
      if (state.caliperPoints.length >= 2) {
        state.caliperPoints = [{ x: imgX, y: imgY }];
        caliperHud.style.display = 'none';
      } else {
        state.caliperPoints.push({ x: imgX, y: imgY });
        if (state.caliperPoints.length === 2) {
          computeCaliperDistance();
        }
      }
      render();
    } else if (state.mode === 'circle') {
      if (state.circlePoints.length >= 3) {
        state.circlePoints = [{ x: imgX, y: imgY }];
        caliperHud.style.display = 'none';
      } else {
        state.circlePoints.push({ x: imgX, y: imgY });
        if (state.circlePoints.length === 3) {
          computeCircleDiameter();
        }
      }
      render();
    }
  }

  async function computeCaliperDistance() {
    const p1 = state.caliperPoints[0];
    const p2 = state.caliperPoints[1];

    try {
      const resp = await fetch('/api/measure-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p1, p2, ppm: state.ppm }),
      });
      const data = await resp.json();

      caliperHud.style.display = 'block';
      hudValue.textContent = data.distance_mm.toFixed(2);
      hudSub.textContent = `Distance: ${data.distance_mm.toFixed(2)} mm | Scale: ${state.ppm.toFixed(1)} px/mm | θ: ${data.angle_deg.toFixed(1)}°`;
    } catch (e) {
      console.error(e);
    }
  }

  async function computeCircleDiameter() {
    const [p1, p2, p3] = state.circlePoints;
    try {
      const resp = await fetch('/api/circle-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p1, p2, p3, ppm: state.ppm }),
      });
      const data = await resp.json();

      caliperHud.style.display = 'block';
      hudValue.innerHTML = `<span style="font-size:1.2rem;">Ø </span>${data.diameter_mm.toFixed(2)}`;
      hudSub.textContent = `Radius: ${data.radius_mm.toFixed(2)} mm | Area: ${data.area_mm2.toFixed(1)} mm²`;
    } catch (e) {
      console.error(e);
    }
  }

  // --- Screen <-> Image Math ---
  function screenToImageCoords(screenX, screenY) {
    const x = (screenX - state.panX) / state.zoom;
    const y = (screenY - state.panY) / state.zoom;
    return { x, y };
  }

  function zoomBy(factor) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    zoomAt(cx, cy, factor);
  }

  function zoomAt(screenX, screenY, factor) {
    const newZoom = Math.min(Math.max(0.1, state.zoom * factor), 8.0);
    state.panX = screenX - (screenX - state.panX) * (newZoom / state.zoom);
    state.panY = screenY - (screenY - state.panY) * (newZoom / state.zoom);
    state.zoom = newZoom;
    render();
  }

  function fitToScreen() {
    const img = getActiveImage();
    if (!img) return;

    const scaleX = (canvas.width - 40) / img.width;
    const scaleY = (canvas.height - 40) / img.height;
    state.zoom = Math.min(scaleX, scaleY, 1.2);
    state.panX = (canvas.width - img.width * state.zoom) / 2;
    state.panY = (canvas.height - img.height * state.zoom) / 2;
    render();
  }

  // --- Download & Exports ---
  function downloadCadImage() {
    const activeImg = getActiveImage();
    if (!activeImg) return;
    const a = document.createElement('a');
    a.href = activeImg.src;
    a.download = state.viewMode === 'cad' ? 'smart_caliper_cad_blueprint.png' : 'smart_caliper_original_photo.png';
    a.click();
  }

  function exportJsonData() {
    if (!state.analysisData) return;
    const str = JSON.stringify(state.analysisData, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'smart_caliper_inspection_report.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function showLoading(msg) {
    loadingText.textContent = msg || 'Processing...';
    loadingOverlay.style.display = 'flex';
  }

  function hideLoading() {
    loadingOverlay.style.display = 'none';
  }

  // Launch on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();
