"""
REST API Routes for SmartCaliper.

Endpoints for image analysis, metric distance measurement, manual calibration,
and preset reference configurations.
"""

import os
import base64
import json
from pathlib import Path
from typing import Optional, List, Tuple
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel, Field
import cv2
import numpy as np

from smart_caliper.config import ReferenceType, REFERENCE_REGISTRY
from smart_caliper.pipeline import CaliperPipeline
from smart_caliper.core.metrology import ToleranceSpec
from smart_caliper.core.subpixel import fit_circle_subpixel
from smart_caliper.core.homography import pixel_to_mm

router = APIRouter(prefix="/api", tags=["Metrology API"])
pipeline = CaliperPipeline()

SAMPLES_DIR = Path(__file__).resolve().parent.parent.parent / "samples"


class Point(BaseModel):
    x: float
    y: float


class MeasurePointsRequest(BaseModel):
    p1: Point
    p2: Point
    ppm: float


class CirclePointsRequest(BaseModel):
    p1: Point
    p2: Point
    p3: Point
    ppm: float


class ManualCalibrationRequest(BaseModel):
    corners: List[Point] = Field(..., min_length=4, max_length=4)
    ref_type: ReferenceType = ReferenceType.ISO_CARD
    custom_width_mm: Optional[float] = None
    custom_height_mm: Optional[float] = None


@router.get("/health")
def health_check():
    return {
        "status": "online",
        "engine": "SmartCaliper",
        "version": "1.0.0",
        "cv_backend": "OpenCV " + cv2.__version__,
    }


@router.get("/presets")
def get_reference_presets():
    """Returns all available reference targets with their physical millimeter dimensions."""
    presets = []
    for k, v in REFERENCE_REGISTRY.items():
        presets.append({
            "id": v.ref_type.value,
            "name": v.name,
            "width_mm": v.width_mm,
            "height_mm": v.height_mm,
            "diameter_mm": v.diameter_mm,
            "is_circular": v.is_circular,
            "aspect_ratio": round(v.aspect_ratio, 3),
        })
    return presets


@router.get("/samples")
def get_sample_list():
    """Returns available demonstration images for 1-click evaluation."""
    samples = [
        {
            "id": "card",
            "name": "ISO Credit Card + Machined Bar & Disk",
            "filename": "sample_card_inspection.png",
            "default_ref": "iso_card",
            "description": "Standard 85.60 x 53.98 mm credit card with 60x25 mm bar and 30 mm disk.",
        },
        {
            "id": "coin",
            "name": "1 TL Coin + Mechanical Bracket",
            "filename": "sample_coin_bracket.png",
            "default_ref": "coin_1_tl",
            "description": "Turkish 1 Lira coin (Ø 26.15 mm) with 45x22 mm bracket.",
        },
        {
            "id": "aruco",
            "name": "ArUco Marker 4x4 + Electronics IC",
            "filename": "sample_aruco_components.png",
            "default_ref": "aruco_4x4_50mm",
            "description": "Fiducial marker (50x50 mm) with DIP integrated circuit chip.",
        }
    ]
    return samples


@router.get("/samples/{filename}")
def get_sample_file(filename: str):
    """Serves sample image files."""
    file_path = SAMPLES_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Sample image not found")
    return FileResponse(path=str(file_path), media_type="image/png")


@router.post("/analyze")
async def analyze_image(
    file: Optional[UploadFile] = File(None),
    sample_name: Optional[str] = Form(None),
    ref_type: str = Form(ReferenceType.ISO_CARD.value),
    custom_width_mm: Optional[float] = Form(None),
    custom_height_mm: Optional[float] = Form(None),
    manual_corners_json: Optional[str] = Form(None),
    nominal_length: Optional[float] = Form(None),
    tol_length: Optional[float] = Form(None),
    nominal_width: Optional[float] = Form(None),
    tol_width: Optional[float] = Form(None),
    nominal_diameter: Optional[float] = Form(None),
    tol_diameter: Optional[float] = Form(None),
):
    """
    Analyzes an uploaded image or pre-loaded sample:
    1. Detects reference calibration standard
    2. Recovers metric plane via Homography
    3. Segments foreground objects
    4. Computes sub-pixel geometric metrology
    5. Generates CAD blueprint visualization
    """
    # Read image
    if file is not None:
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    elif sample_name:
        sample_path = SAMPLES_DIR / sample_name
        if not sample_path.exists():
            raise HTTPException(status_code=404, detail=f"Sample '{sample_name}' not found.")
        img = cv2.imread(str(sample_path))
    else:
        raise HTTPException(status_code=400, detail="Must provide an image file or sample_name.")
        
    if img is None or img.size == 0:
        raise HTTPException(status_code=400, detail="Could not decode image.")
        
    # Parse reference type
    try:
        reference_enum = ReferenceType(ref_type)
    except ValueError:
        reference_enum = ReferenceType.ISO_CARD
        
    # Parse manual corners if provided
    manual_corners = None
    if manual_corners_json:
        try:
            corners_list = json.loads(manual_corners_json)
            if len(corners_list) == 4:
                manual_corners = [(float(pt["x"]), float(pt["y"])) for pt in corners_list]
        except Exception:
            pass
            
    # Parse tolerance
    tolerance = None
    if any([nominal_length, nominal_width, nominal_diameter]):
        tolerance = ToleranceSpec(
            nominal_length_mm=nominal_length,
            tol_length_mm=tol_length or 0.5,
            nominal_width_mm=nominal_width,
            tol_width_mm=tol_width or 0.5,
            nominal_diameter_mm=nominal_diameter,
            tol_diameter_mm=tol_diameter or 0.5,
        )
        
    try:
        result = pipeline.process(
            image=img,
            reference_type=reference_enum,
            manual_corners=manual_corners,
            custom_width_mm=custom_width_mm,
            custom_height_mm=custom_height_mm,
            tolerance=tolerance,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inspection failed: {str(e)}")
        
    # Encode images to Base64 PNG for instant web display
    _, buffer_rect = cv2.imencode(".png", result.rectified_image)
    b64_rect = base64.b64encode(buffer_rect).decode("utf-8")
    
    _, buffer_cad = cv2.imencode(".png", result.annotated_image)
    b64_cad = base64.b64encode(buffer_cad).decode("utf-8")
    
    # Pack response
    response_data = result.to_dict()
    response_data["images"] = {
        "rectified_png_b64": f"data:image/png;base64,{b64_rect}",
        "cad_annotated_png_b64": f"data:image/png;base64,{b64_cad}",
    }
    response_data["reference_detected_corners_original"] = [
        {"x": round(float(pt[0]), 1), "y": round(float(pt[1]), 1)}
        for pt in result.reference.corners
    ]
    
    return JSONResponse(content=response_data)


@router.post("/measure-points")
def measure_two_points(req: MeasurePointsRequest):
    """Computes calibrated physical distance (mm) between two points on the canvas."""
    if req.ppm <= 0:
        raise HTTPException(status_code=400, detail="Invalid PPM scale value.")
    dx = req.p2.x - req.p1.x
    dy = req.p2.y - req.p1.y
    dist_px = np.hypot(dx, dy)
    dist_mm = pixel_to_mm(dist_px, req.ppm)
    angle_deg = np.degrees(np.arctan2(dy, dx)) % 180.0
    
    return {
        "distance_mm": round(float(dist_mm), 2),
        "distance_px": round(float(dist_px), 1),
        "angle_deg": round(float(angle_deg), 1),
        "dx_mm": round(float(abs(dx) / req.ppm), 2),
        "dy_mm": round(float(abs(dy) / req.ppm), 2),
    }


@router.post("/circle-points")
def fit_circle_from_three_points(req: CirclePointsRequest):
    """Fits an exact circle through 3 user-selected points and returns diameter in mm."""
    if req.ppm <= 0:
        raise HTTPException(status_code=400, detail="Invalid PPM scale value.")
    pts = np.array([
        [req.p1.x, req.p1.y],
        [req.p2.x, req.p2.y],
        [req.p3.x, req.p3.y],
    ], dtype=np.float32)
    
    try:
        cx, cy, r, rmse = fit_circle_subpixel(pts)
        diam_mm = (r * 2.0) / req.ppm
        return {
            "center_px": {"x": round(cx, 1), "y": round(cy, 1)},
            "radius_px": round(r, 1),
            "diameter_mm": round(float(diam_mm), 2),
            "radius_mm": round(float(r / req.ppm), 2),
            "area_mm2": round(float(np.pi * (diam_mm / 2.0)**2), 2),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not fit circle: {str(e)}")
