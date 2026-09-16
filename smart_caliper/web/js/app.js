/**
 * Mezuram — Minimalist Camera Measurement Engine (iOS Measure Style)
 */

(function () {
  'use strict';

  // --- Known Physical Dimensions ---
  const REFERENCE_SPECS = {
    iso_card: { width_mm: 85.60, height_mm: 53.98, label: 'Kredi Kartı' },
    coin_1_tl: { width_mm: 26.15, height_mm: 26.15, label: '1 TL' },
    coin_1_euro: { width_mm: 23.25, height_mm: 23.25, label: '1 Euro' },
    aruco_4x4_50mm: { width_mm: 50.00, height_mm: 50.00, label: 'ArUco (50 mm)' },
  };

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

    // Metric Homography Matrix: 3x3 Projective transform from image px to real mm
    homographyMatrix: null,
    ppm: 10.0, // fallback pixels per mm

    // Reference Corners (in image coordinates)
    pinCorners: null, // [ {x, y}, {x, y}, {x, y}, {x, y} ]
    detectedCorners: null,
    activePinIndex: -1,

    // Completed measurements: [ { p1: {x, y}, p2: {x, y}, distance_mm: 48.5 } ]
    measurements: [],
    activePoint1: null, // current pending start point {x, y}
    cursorPoint: null,  // current cursor/touch position {x, y}

    // Detected Objects for tracking and auto-selection
    detectedObjects: [],
    hoveredObject: null,
    selectedObjectId: null,
    snapPoint: null, // { x, y } when snapping to object/card corner

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
  const btnUndoMeasurement = document.getElementById('btnUndoMeasurement');
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

    // Undo measurement
    if (btnUndoMeasurement) {
      btnUndoMeasurement.addEventListener('click', undoLastMeasurement);
    }

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
      updateHomographyMatrix();
      render();
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

    const refType = selectRef.value || 'iso_card';
    const spec = REFERENCE_SPECS[refType] || REFERENCE_SPECS.iso_card;

    // Detected Objects (Keys, screws, brackets, objects on desk)
    state.detectedObjects = (data.measurements || []).filter(
      m => m.box_corners_original && m.box_corners_original.length === 4
    );

    // Detected Reference Corners
    const conf = Math.round((data.calibration.confidence || 0) * 100);
    const hasAutoDetectedCard = data.reference_detected_corners_original && data.reference_detected_corners_original.length === 4;

    if (hasAutoDetectedCard) {
      state.detectedCorners = JSON.parse(JSON.stringify(data.reference_detected_corners_original));
      state.pinCorners = JSON.parse(JSON.stringify(data.reference_detected_corners_original));
    }

    // Load Image: prefer original_png_b64 for natural, non-warped viewing!
    const img = new Image();
    img.src = data.images.original_png_b64 || data.images.rectified_png_b64;
    img.onload = () => {
      state.image = img;
      state.imageWidth = img.width;
      state.imageHeight = img.height;

      if (!state.pinCorners) {
        state.pinCorners = getDefaultPinCorners(state.imageWidth, state.imageHeight, spec.width_mm, spec.height_mm);
      }

      updateHomographyMatrix();

      dropzone.style.display = 'none';
      canvas.style.display = 'block';
      fitToScreen();
      render();

      if (hasAutoDetectedCard && conf > 30) {
        setStatus(`✓ ${spec.label} Algılandı (%${conf} Doğruluk). Ölçmek istediğiniz nesneye dokunun.`);
      } else {
        setMode('pin');
        setStatus(`⚠️ Kart otomatik bulunamadı. Lütfen "Kartı Hizala" butonundaki 4 mavi köşeyi kartınızın köşelerine sürükleyin.`);
      }
    };
  }

  function applyPinCalibration() {
    updateHomographyMatrix();
    setMode('measure');
    setStatus('✓ Kalibrasyon güncellendi! Artık hassas ölçüm yapabilirsiniz.');
  }

  function resetPinsToDetected() {
    if (state.detectedCorners) {
      state.pinCorners = JSON.parse(JSON.stringify(state.detectedCorners));
      updateHomographyMatrix();
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

    // 2. Draw Detected Objects (Tracking & Selection Outlines)
    renderDetectedObjects();

    // 3. Draw Reference Target Outline (Card / Coin)
    renderReferenceOutline();

    // 4. Draw Completed Measurements
    state.measurements.forEach(m => {
      drawMeasureLine(m.p1, m.p2, m.distance_mm, false);
    });

    // 5. Draw Active Rubberband Line (While dragging/placing 2nd point)
    if (state.activePoint1 && state.cursorPoint && state.mode === 'measure') {
      const liveMm = calculatePhysicalDistanceMm(state.activePoint1, state.cursorPoint);
      drawMeasureLine(state.activePoint1, state.cursorPoint, liveMm, true);
    }

    // 6. Draw Magnetic Snap Indicator
    if (state.snapPoint && state.mode === 'measure') {
      drawSnapTarget(state.snapPoint.x, state.snapPoint.y);
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
        updateHomographyMatrix();
        updateMagnifier(screenX, screenY, imgCoord.x, imgCoord.y);
        render();
        return;
      }

      // Check object hover and corner snapping
      if (state.mode === 'measure') {
        const snap = findSnappingPoint(imgCoord.x, imgCoord.y);
        state.snapPoint = snap;
        const effectiveX = snap ? snap.x : imgCoord.x;
        const effectiveY = snap ? snap.y : imgCoord.y;

        state.hoveredObject = state.detectedObjects.find(obj =>
          obj.box_corners_original && isPointInPolygon({ x: imgCoord.x, y: imgCoord.y }, obj.box_corners_original)
        ) || null;

        // Measuring rubberband preview
        if (state.activePoint1) {
          state.cursorPoint = { x: effectiveX, y: effectiveY };
          updateMagnifier(screenX, screenY, effectiveX, effectiveY);
        }
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
          updateHomographyMatrix();
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
  function handleCanvasTap(rawX, rawY) {
    if (state.mode !== 'measure') return;

    // Apply magnetic snapping if near an object corner
    const snap = findSnappingPoint(rawX, rawY);
    const imgX = snap ? snap.x : rawX;
    const imgY = snap ? snap.y : rawY;

    // If no first point is active, check if user tapped directly inside a detected object (1-Tap Measure)
    if (!state.activePoint1) {
      const clickedObj = state.detectedObjects.find(obj =>
        obj.box_corners_original && isPointInPolygon({ x: rawX, y: rawY }, obj.box_corners_original)
      );

      if (clickedObj) {
        state.selectedObjectId = clickedObj.id;
        const pts = clickedObj.box_corners_original;
        // Add length measurement line
        const p1 = { x: (pts[0].x + pts[3].x) / 2, y: (pts[0].y + pts[3].y) / 2 };
        const p2 = { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 };
        const distMm = calculatePhysicalDistanceMm(p1, p2);

        state.measurements.push({
          p1: p1,
          p2: p2,
          distance_mm: distMm,
        });

        setStatus(`✓ Nesne #${clickedObj.id} seçildi: ${clickedObj.dimensions_mm.length.toFixed(1)} mm × ${clickedObj.dimensions_mm.width.toFixed(1)} mm`);
        render();
        return;
      }
    }

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
      const distMm = calculatePhysicalDistanceMm(p1, p2);

      state.measurements.push({
        p1: p1,
        p2: p2,
        distance_mm: distMm,
      });

      state.activePoint1 = null;
      state.cursorPoint = null;
      state.snapPoint = null;

      const formatted = distMm >= 50 ? `${(distMm / 10).toFixed(2)} cm` : `${distMm.toFixed(1)} mm`;
      setStatus(`✓ Ölçüm: ${formatted} — Başka bir şey ölçmek için tekrar dokunun.`);
      render();
    }
  }

  // --- Real-time Homography Math & Coordinate Transform ---
  function computeHomography(src, targetWidthMm, targetHeightMm) {
    if (!src || src.length !== 4) return null;
    const dst = [
      { x: 0, y: 0 },
      { x: targetWidthMm, y: 0 },
      { x: targetWidthMm, y: targetHeightMm },
      { x: 0, y: targetHeightMm },
    ];

    const A = [];
    const B = [];

    for (let i = 0; i < 4; i++) {
      const x = src[i].x;
      const y = src[i].y;
      const u = dst[i].x;
      const v = dst[i].y;

      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      B.push(u);

      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      B.push(v);
    }

    const n = 8;
    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
          maxRow = k;
        }
      }
      const tempA = A[i]; A[i] = A[maxRow]; A[maxRow] = tempA;
      const tempB = B[i]; B[i] = B[maxRow]; B[maxRow] = tempB;

      if (Math.abs(A[i][i]) < 1e-12) continue;

      for (let k = i + 1; k < n; k++) {
        const c = A[k][i] / A[i][i];
        for (let j = i; j < n; j++) {
          A[k][j] -= c * A[i][j];
        }
        B[k] -= c * B[i];
      }
    }

    const h = new Array(8).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = B[i];
      for (let j = i + 1; j < n; j++) {
        sum -= A[i][j] * h[j];
      }
      h[i] = sum / A[i][i];
    }

    return [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1.0],
    ];
  }

  function projectPointToMm(pt, H) {
    if (!H) return null;
    const u = H[0][0] * pt.x + H[0][1] * pt.y + H[0][2];
    const v = H[1][0] * pt.x + H[1][1] * pt.y + H[1][2];
    const w = H[2][0] * pt.x + H[2][1] * pt.y + H[2][2];
    if (Math.abs(w) < 1e-8) return null;
    return { x: u / w, y: v / w };
  }

  function calculatePhysicalDistanceMm(p1, p2) {
    if (state.homographyMatrix) {
      const mm1 = projectPointToMm(p1, state.homographyMatrix);
      const mm2 = projectPointToMm(p2, state.homographyMatrix);
      if (mm1 && mm2) {
        return Math.hypot(mm2.x - mm1.x, mm2.y - mm1.y);
      }
    }
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.hypot(dx, dy) / (state.ppm || 10.0);
  }

  function updateHomographyMatrix() {
    if (!state.pinCorners || state.pinCorners.length !== 4) return;
    const refType = selectRef.value || 'iso_card';
    const spec = REFERENCE_SPECS[refType] || REFERENCE_SPECS.iso_card;
    state.homographyMatrix = computeHomography(state.pinCorners, spec.width_mm, spec.height_mm);

    // Live update all completed measurements with updated calibration
    if (state.measurements && state.measurements.length > 0) {
      state.measurements.forEach(m => {
        m.distance_mm = calculatePhysicalDistanceMm(m.p1, m.p2);
      });
    }
  }

  function getDefaultPinCorners(imgW, imgH, refW, refH) {
    const aspect = refW / refH;
    const boxW = Math.min(imgW * 0.45, 450);
    const boxH = boxW / aspect;
    const cx = imgW / 2;
    const cy = imgH / 2;
    return [
      { x: Math.round(cx - boxW / 2), y: Math.round(cy - boxH / 2) },
      { x: Math.round(cx + boxW / 2), y: Math.round(cy - boxH / 2) },
      { x: Math.round(cx + boxW / 2), y: Math.round(cy + boxH / 2) },
      { x: Math.round(cx - boxW / 2), y: Math.round(cy + boxH / 2) },
    ];
  }

  function undoLastMeasurement() {
    if (state.activePoint1) {
      state.activePoint1 = null;
      state.cursorPoint = null;
      render();
      setStatus('Nokta seçimi iptal edildi.');
      return;
    }
    if (state.measurements.length > 0) {
      state.measurements.pop();
      render();
      setStatus('Son ölçüm geri alındı.');
    }
  }

  function isPointInPolygon(pt, poly) {
    if (!poly || poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > pt.y) !== (yj > pt.y))
          && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function findSnappingPoint(imgX, imgY) {
    const snapRadius = 24 / state.zoom;
    let closest = null;
    let minD = snapRadius;

    // 1. Check detected object corners
    if (state.detectedObjects) {
      state.detectedObjects.forEach(obj => {
        if (obj.box_corners_original) {
          obj.box_corners_original.forEach(p => {
            const d = Math.hypot(p.x - imgX, p.y - imgY);
            if (d < minD) {
              minD = d;
              closest = { x: p.x, y: p.y };
            }
          });
        }
      });
    }

    // 2. Check reference card corners
    if (state.pinCorners) {
      state.pinCorners.forEach(p => {
        const d = Math.hypot(p.x - imgX, p.y - imgY);
        if (d < minD) {
          minD = d;
          closest = { x: p.x, y: p.y };
        }
      });
    }

    return closest;
  }

  function renderDetectedObjects() {
    if (!state.detectedObjects || state.detectedObjects.length === 0) return;

    state.detectedObjects.forEach(obj => {
      const isHovered = state.hoveredObject && state.hoveredObject.id === obj.id;
      const isSelected = state.selectedObjectId === obj.id;
      const pts = obj.box_corners_original;
      if (!pts || pts.length !== 4) return;

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();

      if (isSelected) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3 / state.zoom;
        ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
        ctx.fill();
        ctx.stroke();
      } else if (isHovered) {
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5 / state.zoom;
        ctx.fillStyle = 'rgba(0, 240, 255, 0.15)';
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.setLineDash([4 / state.zoom, 4 / state.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw dimension pill at object center
      const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
      const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
      const dimText = `${obj.dimensions_mm.length.toFixed(1)} × ${obj.dimensions_mm.width.toFixed(1)} mm`;
      drawObjectBadge(cx, cy, dimText, isSelected || isHovered);
    });
  }

  function drawObjectBadge(x, y, text, isHighlighted) {
    ctx.font = `bold ${12 / state.zoom}px Outfit, sans-serif`;
    const metrics = ctx.measureText(text);
    const padX = 8 / state.zoom;
    const boxW = metrics.width + padX * 2;
    const boxH = 20 / state.zoom;
    const radius = 5 / state.zoom;
    const bx = x - boxW / 2;
    const by = y - boxH / 2;

    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, radius);
    ctx.fillStyle = isHighlighted ? 'rgba(15, 23, 42, 0.95)' : 'rgba(15, 23, 42, 0.8)';
    ctx.fill();
    ctx.strokeStyle = isHighlighted ? '#00f0ff' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1 / state.zoom;
    ctx.stroke();

    ctx.fillStyle = isHighlighted ? '#00f0ff' : '#cbd5e1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function drawSnapTarget(x, y) {
    const r = 12 / state.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2.5 / state.zoom;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 4 / state.zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#10b981';
    ctx.fill();
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
