"""
Metrology & Defect Analysis Module.

Extracts precision geometric primitives (Rotated Bounding Box, Pratt Circle Fit,
Feret Diameters, Calibrated Surface Area, Perimeter, Circularity, Convexity)
and performs statistical tolerance validation (Pass/Fail).
"""

from typing import List, Tuple, Optional, Dict, Any
from dataclasses import dataclass, field
import numpy as np
import cv2
from scipy.spatial.distance import cdist

from smart_caliper.core.subpixel import extract_subpixel_contour, fit_circle_subpixel
from smart_caliper.core.homography import pixel_to_mm


@dataclass
class ToleranceSpec:
    """Engineering tolerance criteria for Quality Assurance (QA)."""
    nominal_length_mm: Optional[float] = None
    tol_length_mm: Optional[float] = None    # +/- allowable deviation
    nominal_width_mm: Optional[float] = None
    tol_width_mm: Optional[float] = None
    nominal_diameter_mm: Optional[float] = None
    tol_diameter_mm: Optional[float] = None


@dataclass
class ObjectMeasurement:
    """Comprehensive metrology and defect profile for a single inspected object."""
    object_id: int
    centroid_px: Tuple[float, float]
    centroid_mm: Tuple[float, float]
    
    # Linear Dimensions
    length_mm: float
    width_mm: float
    aspect_ratio: float
    orientation_deg: float
    
    # Area & Perimeter
    area_mm2: float
    perimeter_mm: float
    equivalent_diameter_mm: float
    
    # Circular Features
    is_circular: bool
    circle_center_mm: Optional[Tuple[float, float]] = None
    circle_diameter_mm: Optional[float] = None
    circle_fit_rmse_mm: Optional[float] = None
    
    # Advanced Metrology / Calipers
    max_feret_diameter_mm: float = 0.0
    min_feret_diameter_mm: float = 0.0
    
    # Shape & Defect Factors
    circularity: float = 0.0        # 4*pi*Area / P^2 (1.0 for perfect circle)
    solidity: float = 0.0           # Area / ConvexHullArea (1.0 for convex)
    defect_score: float = 0.0       # Edge roughness / notch anomaly [0.0 = clean, 1.0 = severe defect]
    
    # QA Tolerance Status
    qa_passed: Optional[bool] = None
    qa_message: Optional[str] = None
    
    # Geometric primitives for CAD overlay (in rectified pixels)
    box_corners_px: np.ndarray = field(default_factory=lambda: np.zeros((4, 2)))
    subpixel_contour_px: Optional[np.ndarray] = None


class MetrologyCalculator:
    """Computes precision physical measurements from contours in rectified metric space."""

    def __init__(self, ppm: float):
        if ppm <= 0:
            raise ValueError(f"PPM must be positive, got {ppm}")
        self.ppm = ppm

    def analyze_object(
        self,
        gray_image: np.ndarray,
        contour: np.ndarray,
        object_id: int = 1,
        tolerance: Optional[ToleranceSpec] = None,
        origin_offset_mm: Tuple[float, float] = (0.0, 0.0),
    ) -> ObjectMeasurement:
        """
        Executes sub-pixel edge refinement, calculates physical geometric parameters,
        and checks engineering tolerances.
        """
        # 1. Sub-pixel contour refinement
        sub_pts = extract_subpixel_contour(gray_image, contour, search_radius=2)
        
        # 2. Centroid calculation
        M = cv2.moments(contour)
        if M["m00"] != 0:
            cx_px = M["m10"] / M["m00"]
            cy_px = M["m01"] / M["m00"]
        else:
            cx_px, cy_px = float(np.mean(sub_pts[:, 0])), float(np.mean(sub_pts[:, 1]))
            
        cx_mm = pixel_to_mm(cx_px, self.ppm) + origin_offset_mm[0]
        cy_mm = pixel_to_mm(cy_px, self.ppm) + origin_offset_mm[1]
        
        # 3. Minimum Area Rotated Bounding Box
        rect = cv2.minAreaRect(sub_pts.astype(np.float32))
        (center_x, center_y), (dim_w, dim_h), angle = rect
        
        box_corners = cv2.boxPoints(rect)
        
        # Consistent length (longer side) and width (shorter side)
        dim_long_px = max(dim_w, dim_h)
        dim_short_px = min(dim_w, dim_h)
        
        length_mm = pixel_to_mm(dim_long_px, self.ppm)
        width_mm = pixel_to_mm(dim_short_px, self.ppm)
        aspect_ratio = length_mm / max(width_mm, 1e-4)
        
        # Normalize orientation angle
        if dim_w < dim_h:
            angle = (angle + 90.0) % 180.0
        else:
            angle = angle % 180.0
            
        # 4. Area & Perimeter (Green's Theorem / Contour integration)
        area_px = cv2.contourArea(contour)
        peri_px = cv2.arcLength(contour, closed=True)
        
        area_mm2 = area_px / (self.ppm ** 2)
        peri_mm = pixel_to_mm(peri_px, self.ppm)
        equiv_diam_mm = np.sqrt(4.0 * area_mm2 / np.pi)
        
        # 5. Form Factors & Defect Analysis
        circularity = (4.0 * np.pi * area_px) / max(1e-4, peri_px ** 2)
        circularity = min(1.0, max(0.0, float(circularity)))
        
        hull = cv2.convexHull(contour)
        hull_area = cv2.contourArea(hull)
        solidity = area_px / max(1e-4, hull_area)
        solidity = min(1.0, max(0.0, float(solidity)))
        
        # Defect anomaly score: combination of non-solidity and contour irregularity
        defect_score = float(np.clip(1.0 - solidity, 0.0, 1.0))
        
        # 6. Circular fitting (Pratt's algebraic fit) if object resembles circle
        is_circular = circularity >= 0.78 and (0.85 <= aspect_ratio <= 1.20)
        circle_center_mm = None
        circle_diameter_mm = None
        circle_rmse_mm = None
        
        if is_circular and len(sub_pts) >= 6:
            try:
                fit_cx, fit_cy, fit_r, rmse_px = fit_circle_subpixel(sub_pts)
                circle_center_mm = (
                    pixel_to_mm(fit_cx, self.ppm) + origin_offset_mm[0],
                    pixel_to_mm(fit_cy, self.ppm) + origin_offset_mm[1]
                )
                circle_diameter_mm = pixel_to_mm(fit_r * 2.0, self.ppm)
                circle_rmse_mm = pixel_to_mm(rmse_px, self.ppm)
            except Exception:
                is_circular = False
                
        # 7. Feret Diameters (Calipers: max distance across contour)
        # Subsample contour for fast pairwise distance matrix
        subsample_cnt = sub_pts[::max(1, len(sub_pts) // 60)]
        if len(subsample_cnt) > 2:
            dists = cdist(subsample_cnt, subsample_cnt)
            max_feret_px = np.max(dists)
            max_feret_mm = pixel_to_mm(max_feret_px, self.ppm)
        else:
            max_feret_mm = length_mm
            
        min_feret_mm = width_mm
        
        # 8. QA Tolerance Check
        qa_passed = None
        qa_message = None
        if tolerance is not None:
            qa_passed, qa_message = self._check_tolerances(
                length_mm, width_mm, circle_diameter_mm, tolerance
            )
            
        return ObjectMeasurement(
            object_id=object_id,
            centroid_px=(float(cx_px), float(cy_px)),
            centroid_mm=(float(cx_mm), float(cy_mm)),
            length_mm=round(float(length_mm), 2),
            width_mm=round(float(width_mm), 2),
            aspect_ratio=round(float(aspect_ratio), 2),
            orientation_deg=round(float(angle), 1),
            area_mm2=round(float(area_mm2), 2),
            perimeter_mm=round(float(peri_mm), 2),
            equivalent_diameter_mm=round(float(equiv_diam_mm), 2),
            is_circular=is_circular,
            circle_center_mm=tuple(round(v, 2) for v in circle_center_mm) if circle_center_mm else None,
            circle_diameter_mm=round(float(circle_diameter_mm), 2) if circle_diameter_mm else None,
            circle_fit_rmse_mm=round(float(circle_rmse_mm), 3) if circle_rmse_mm else None,
            max_feret_diameter_mm=round(float(max_feret_mm), 2),
            min_feret_diameter_mm=round(float(min_feret_mm), 2),
            circularity=round(float(circularity), 3),
            solidity=round(float(solidity), 3),
            defect_score=round(float(defect_score), 3),
            qa_passed=qa_passed,
            qa_message=qa_message,
            box_corners_px=box_corners,
            subpixel_contour_px=sub_pts,
        )

    def _check_tolerances(
        self,
        length_mm: float,
        width_mm: float,
        circle_diam_mm: Optional[float],
        spec: ToleranceSpec,
    ) -> Tuple[bool, str]:
        """Evaluates measured dimensions against engineering limits."""
        failures = []
        
        if spec.nominal_length_mm is not None and spec.tol_length_mm is not None:
            diff = abs(length_mm - spec.nominal_length_mm)
            if diff > spec.tol_length_mm:
                failures.append(f"Length {length_mm:.2f}mm deviates by {diff:.2f}mm (> +/-{spec.tol_length_mm}mm)")
                
        if spec.nominal_width_mm is not None and spec.tol_width_mm is not None:
            diff = abs(width_mm - spec.nominal_width_mm)
            if diff > spec.tol_width_mm:
                failures.append(f"Width {width_mm:.2f}mm deviates by {diff:.2f}mm (> +/-{spec.tol_width_mm}mm)")
                
        if spec.nominal_diameter_mm is not None and spec.tol_diameter_mm is not None:
            val = circle_diam_mm or length_mm
            diff = abs(val - spec.nominal_diameter_mm)
            if diff > spec.tol_diameter_mm:
                failures.append(f"Diameter {val:.2f}mm deviates by {diff:.2f}mm (> +/-{spec.tol_diameter_mm}mm)")
                
        if failures:
            return False, "; ".join(failures)
        return True, "All dimensions within specification limits."
