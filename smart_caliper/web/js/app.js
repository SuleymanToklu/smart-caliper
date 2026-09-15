/**
 * SmartCaliper — Client-side CAD Canvas & Metrology Engine
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    mode: 'auto', // 'auto', 'caliper', 'circle'
    currentSample: null,
    analysisData: null,
    rawImage: null,
    cadImage: null,
    showCad: true,
    ppm: 10.0,
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    startPanX: 0,
    startPanY: 0,
    caliperPoints: [], // [ {x, y}, {x, y} ]
    circlePoints: [],  // [ {x, y}, {x, y}, {x, y} ]
  };

  // --- DOM Elements ---
  const canvas = document.getElementById('cadCanvas');
  const ctx = canvas.getContext('2d');
  const canvasWrapper = document.getElementById('canvasWrapper');
  const dropzone = document.getElementById('dropzone');
  const caliperHud = document.getElementById('caliperHud');
  const hudValue = document.getElementById('hudValue');
  const hudSub = document.getElementById('hudSub');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');

  const fileCamera = document.getElementById('fileInputCamera');
  const fileUpload = document.getElementById('fileInputUpload');
  const selectRef = document.getElementById('selectReference');
  const customDimsRow = document.getElementById('customDimsRow');
  const customWidth = document.getElementById('customWidth');
  const customHeight = document.getElementById('customHeight');

  const nomLength = document.getElementById('nomLength');
  const tolLength = document.getElementById('tolLength');
  const nomWidth = document.getElementById('nomWidth');
  const tolWidth = document.getElementById('tolWidth');
  const btnReanalyze = document.getElementById('btnReanalyze');

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
    // Mode switcher
    document.querySelectorAll('#modePills .pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#modePills .pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        state.caliperPoints = [];
        state.circlePoints = [];
        statMode.textContent = btn.textContent.trim();
        caliperHud.style.display = 'none';
        render();
      });
    });

    // File uploads
    fileCamera.addEventListener('change', e => handleFileSelect(e.target.files[0]));
    fileUpload.addEventListener('change', e => handleFileSelect(e.target.files[0]));

    // Sample buttons
    document.querySelectorAll('.btn-sample').forEach(btn => {
      btn.addEventListener('click', () => {
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
        loadSample(state.currentSample, selectRef.value);
      } else if (state.currentFile) {
        uploadFile(state.currentFile);
      }
    });

    // Zoom Controls
    btnZoomIn.addEventListener('click', () => { zoomBy(1.2); });
    btnZoomOut.addEventListener('click', () => { zoomBy(0.8); });
    btnZoomFit.addEventListener('click', fitToScreen);

    // Toggle CAD
    btnToggleCad.addEventListener('click', () => {
      state.showCad = !state.showCad;
      btnToggleCad.classList.toggle('active', state.showCad);
      render();
    });

    // Export CAD
    btnDownloadCad.addEventListener('click', downloadCadImage);

    // Export JSON
    btnExportJson.addEventListener('click', exportJsonData);

    // Mouse & Touch Pan/Zoom/Click
    setupCanvasInteractions();
  }

  // --- API Requests ---
  async function loadSample(sampleName, refType) {
    state.currentSample = sampleName;
    state.currentFile = null;
    showLoading(`Analyzing sample ${sampleName}...`);

    const formData = new FormData();
    formData.append('sample_name', sampleName);
    formData.append('ref_type', refType || selectRef.value);
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

  async function uploadFile(file) {
    if (!file) return;
    state.currentFile = file;
    state.currentSample = null;
    showLoading('Uploading & analyzing image...');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('ref_type', selectRef.value);
    if (selectRef.value === 'custom_rect') {
      formData.append('custom_width_mm', customWidth.value);
      formData.append('custom_height_mm', customHeight.value);
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

    // Load Images
    const imgRaw = new Image();
    imgRaw.src = data.images.rectified_png_b64;
    imgRaw.onload = () => {
      state.rawImage = imgRaw;
      fitToScreen();
      render();
    };

    const imgCad = new Image();
    imgCad.src = data.images.cad_annotated_png_b64;
    imgCad.onload = () => {
      state.cadImage = imgCad;
      render();
    };

    dropzone.style.display = 'none';

    // Update Stats Footer
    statScale.innerHTML = `Scale: <strong>${data.calibration.pixels_per_mm.toFixed(2)} px/mm</strong>`;
    statResolution.innerHTML = `Resolution: <strong>${(data.calibration.resolution_mm_per_pixel * 1000).toFixed(1)} µm/px</strong>`;
    statConfidence.innerHTML = `Confidence: <strong>${(data.calibration.confidence * 100).toFixed(0)}%</strong>`;

    // Update Object Count & Results
    objCount.textContent = data.objects_count;
    renderResultsList(data.measurements);
  }

  function renderResultsList(measurements) {
    resultsList.innerHTML = '';
    if (!measurements || measurements.length === 0) {
      resultsList.innerHTML = '<div class="empty-hint">No parts detected on surface.</div>';
      return;
    }

    let hasPass = false;
    let hasFail = false;

    measurements.forEach(m => {
      const item = document.createElement('div');
      item.className = 'object-item';

      let qaHtml = '';
      if (m.qa_inspection) {
        if (m.qa_inspection.passed) {
          qaHtml = '<span class="object-qa pass">PASS</span>';
          hasPass = true;
        } else {
          qaHtml = '<span class="object-qa fail">FAIL</span>';
          hasFail = true;
        }
      }

      const diamStr = m.circle_metrics.is_circular && m.circle_metrics.diameter_mm
        ? `Ø ${m.circle_metrics.diameter_mm.toFixed(2)} mm`
        : '-';

      item.innerHTML = `
        <div class="object-top">
          <span class="object-id">COMPONENT #${m.id}</span>
          ${qaHtml}
        </div>
        <div class="object-grid">
          <div class="grid-cell"><span>Length:</span> <strong>${m.dimensions_mm.length.toFixed(2)} mm</strong></div>
          <div class="grid-cell"><span>Width:</span> <strong>${m.dimensions_mm.width.toFixed(2)} mm</strong></div>
          <div class="grid-cell"><span>Diameter:</span> <strong>${diamStr}</strong></div>
          <div class="grid-cell"><span>Area:</span> <strong>${m.area_mm2.toFixed(1)} mm²</strong></div>
          <div class="grid-cell"><span>Roundness:</span> <strong>${m.form_factors.circularity.toFixed(2)}</strong></div>
          <div class="grid-cell"><span>Defect:</span> <strong>${m.form_factors.defect_score.toFixed(3)}</strong></div>
        </div>
      `;
      resultsList.appendChild(item);
    });

    if (hasFail) {
      qaBadge.textContent = 'FAIL';
      qaBadge.className = 'badge-pill fail';
    } else if (hasPass) {
      qaBadge.textContent = 'PASS';
      qaBadge.className = 'badge-pill pass';
    } else {
      qaBadge.textContent = 'INSPECTED';
      qaBadge.className = 'badge-pill';
    }
  }

  // --- Canvas Rendering & HUD ---
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const activeImg = state.showCad && state.cadImage ? state.cadImage : state.rawImage;
    if (!activeImg) return;

    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    // Draw rectified / CAD image
    ctx.drawImage(activeImg, 0, 0);

    // Draw active caliper tool overlay
    if (state.mode === 'caliper') {
      renderCaliperTool();
    } else if (state.mode === 'circle') {
      renderCircleTool();
    }

    ctx.restore();
  }

  function renderCaliperTool() {
    const pts = state.caliperPoints;
    if (pts.length === 0) return;

    // Draw first point
    drawPointHandle(pts[0].x, pts[0].y, '#f59e0b');

    if (pts.length === 2) {
      const p1 = pts[0];
      const p2 = pts[1];

      // Draw second point
      drawPointHandle(p2.x, p2.y, '#f59e0b');

      // Caliper measurement line
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2 / state.zoom;
      ctx.setLineDash([4 / state.zoom, 4 / state.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Caliper jaws (perpendicular ticks)
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const nx = -dy / len;
        const ny = dx / len;
        const jawLen = 14 / state.zoom;

        // Jaw at p1
        ctx.beginPath();
        ctx.moveTo(p1.x - nx * jawLen, p1.y - ny * jawLen);
        ctx.lineTo(p1.x + nx * jawLen, p1.y + ny * jawLen);
        // Jaw at p2
        ctx.moveTo(p2.x - nx * jawLen, p2.y - ny * jawLen);
        ctx.lineTo(p2.x + nx * jawLen, p2.y + ny * jawLen);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.5 / state.zoom;
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
      // Fit circle through 3 points
      const circle = getThreePointCircle(pts[0], pts[1], pts[2]);
      if (circle) {
        ctx.beginPath();
        ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2 / state.zoom;
        ctx.stroke();

        // Center crosshair
        const cs = 8 / state.zoom;
        ctx.beginPath();
        ctx.moveTo(circle.x - cs, circle.y);
        ctx.lineTo(circle.x + cs, circle.y);
        ctx.moveTo(circle.x, circle.y - cs);
        ctx.lineTo(circle.x, circle.y + cs);
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.stroke();
      }
    }
  }

  function drawPointHandle(x, y, color, label) {
    const r = 5 / state.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5 / state.zoom;
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

    canvas.addEventListener('mousedown', e => {
      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      state.startPanX = state.panX;
      state.startPanY = state.panY;
    });

    window.addEventListener('mousemove', e => {
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
      if (!isDragging) return;
      isDragging = false;
      if (!hasMoved) {
        // Click event!
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
        isDragging = true;
        hasMoved = false;
        dragStartX = t.clientX;
        dragStartY = t.clientY;
        state.startPanX = state.panX;
        state.startPanY = state.panY;
      } else if (e.touches.length === 2) {
        // Pinch start
        isDragging = false;
        touchStartDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        touchStartZoom = state.zoom;
      }
    });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && isDragging) {
        const t = e.touches[0];
        const dx = t.clientX - dragStartX;
        const dy = t.clientY - dragStartY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          hasMoved = true;
          state.panX = state.startPanX + dx;
          state.panY = state.startPanY + dy;
          render();
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
    });

    canvas.addEventListener('touchend', e => {
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
      hudSub.textContent = `ΔX: ${data.dx_mm.toFixed(1)} mm | ΔY: ${data.dy_mm.toFixed(1)} mm | θ: ${data.angle_deg.toFixed(1)}°`;
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
    const img = state.rawImage;
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
    if (!state.cadImage) return;
    const a = document.createElement('a');
    a.href = state.cadImage.src;
    a.download = 'smart_caliper_cad_drawing.png';
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
