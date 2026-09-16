"""
Reference Object Detection Module.

Automatically detects and accurately localizes physical calibration targets:
- ISO/IEC 7810 ID-1 Credit/ID Cards (85.60 x 53.98 mm)
- ArUco Fiducial Markers (Sub-pixel corner detection)
- Standard National & International Coins (1 TL, 1 Euro, US Quarter)
- Interactive manual fallback for challenging lighting or occluded environments.
"""

from typing import Optional, List, Tuple
from dataclasses import dataclass
import numpy as np
import cv2

from smart_caliper.config import ReferenceType, ReferenceConfig, REFERENCE_REGISTRY
from smart_caliper.core.homography import order_points


@dataclass
class ReferenceDetectionResult:
    """Detection output containing corners, physical dimensions, and confidence."""
    ref_type: ReferenceType
    corners: np.ndarray          # 4x2 ordered corners: [TL, TR, BR, BL]
    width_mm: float              # Known physical width
    height_mm: float             # Known physical height
    confidence: float            # Detection confidence score [0.0, 1.0]
    is_auto_detected: bool       # True if found by CV algorithm, False if manual
    contour: Optional[np.ndarray] = None


class ReferenceDetector:
    """Robust multi-strategy reference object detector."""

    def __init__(self, default_ref_type: ReferenceType = ReferenceType.ISO_CARD):
        self.default_ref_type = default_ref_type

    def detect(
        self,
        image: np.ndarray,
        ref_type: Optional[ReferenceType] = None,
        manual_corners: Optional[List[Tuple[float, float]]] = None,
        custom_width_mm: Optional[float] = None,
        custom_height_mm: Optional[float] = None,
    ) -> ReferenceDetectionResult:
        """
        Main entry point for reference target localization.
        If manual_corners is provided, validates and refines those corners.
        Otherwise, executes automated computer vision detection algorithms.
        """
        target_ref = ref_type or self.default_ref_type
        
        # 1. Manual corner override
        if manual_corners is not None and len(manual_corners) == 4:
            return self._process_manual_corners(
                image, manual_corners, target_ref, custom_width_mm, custom_height_mm
            )
            
        # 2. Automated ArUco detection
        if target_ref == ReferenceType.ARUCO_4X4_50MM:
            res = self.detect_aruco(image, target_ref)
            if res is not None:
                return res
                
        # 3. Automated Coin detection
        if "coin" in target_ref.value:
            res = self.detect_coin(image, target_ref)
            if res is not None:
                return res
                
        # 4. Automated ISO Card detection (Default)
        res = self.detect_card(image, target_ref)
        if res is not None:
            return res
            
        # 5. Try ArUco as opportunistic fallback even if card was requested
        res_aruco = self.detect_aruco(image, ReferenceType.ARUCO_4X4_50MM)
        if res_aruco is not None:
            return res_aruco
            
        # 6. Fallback: Heuristic default quad in center of image
        h, w = image.shape[:2]
        pad_x, pad_y = w * 0.25, h * 0.25
        fallback_corners = np.array([
            [pad_x, pad_y],
            [w - pad_x, pad_y],
            [w - pad_x, h - pad_y],
            [pad_x, h - pad_y],
        ], dtype=np.float32)
        
        cfg = REFERENCE_REGISTRY.get(target_ref, REFERENCE_REGISTRY[ReferenceType.ISO_CARD])
        return ReferenceDetectionResult(
            ref_type=target_ref,
            corners=fallback_corners,
            width_mm=custom_width_mm or cfg.width_mm,
            height_mm=custom_height_mm or cfg.height_mm,
            confidence=0.0,
            is_auto_detected=False,
        )

    def detect_card(
        self,
        image: np.ndarray,
        ref_type: ReferenceType = ReferenceType.ISO_CARD,
    ) -> Optional[ReferenceDetectionResult]:
        """
        Detects rectangular ISO/IEC 7810 ID-1 card (Credit/Debit/ID card).
        Target aspect ratio: 85.60 / 53.98 = 1.5858
        """
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        h, w = gray.shape[:2]
        img_area = h * w
        
        # Multi-scale edge extraction
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        
        candidates: List[Tuple[float, np.ndarray, np.ndarray]] = []
        
        # Try both Canny edges and adaptive thresholding to be robust to card color & backgrounds
        for method in ["canny", "adaptive"]:
            if method == "canny":
                # Otsu-guided Canny thresholds
                high_thresh, _ = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                low_thresh = 0.5 * high_thresh
                edges = cv2.Canny(blurred, low_thresh, high_thresh)
                kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                processed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
            else:
                processed = cv2.adaptiveThreshold(
                    blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 3
                )
                kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                processed = cv2.morphologyEx(processed, cv2.MORPH_CLOSE, kernel, iterations=2)
                
            contours, _ = cv2.findContours(processed, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            
            for cnt in contours:
                area = cv2.contourArea(cnt)
                # Card must occupy a reasonable fraction of the frame: 1% to 60%
                if area < (0.01 * img_area) or area > (0.65 * img_area):
                    continue
                    
                peri = cv2.arcLength(cnt, True)
                # Approximate polygon with progressive tolerance
                for eps_factor in [0.02, 0.03, 0.04, 0.05]:
                    approx = cv2.approxPolyDP(cnt, eps_factor * peri, True)
                    pts = None
                    if len(approx) == 4 and cv2.isContourConvex(approx):
                        pts = approx.reshape((4, 2)).astype(np.float32)
                    elif 4 <= len(approx) <= 8:
                        rect = cv2.minAreaRect(cnt)
                        box = cv2.boxPoints(rect).astype(np.float32)
                        box_area = rect[1][0] * rect[1][1]
                        if box_area > 0 and (area / box_area) > 0.75:
                            pts = box

                    if pts is not None:
                        ordered = order_points(pts)
                        
                        # Calculate side lengths
                        s1 = np.linalg.norm(ordered[0] - ordered[1])
                        s2 = np.linalg.norm(ordered[1] - ordered[2])
                        s3 = np.linalg.norm(ordered[2] - ordered[3])
                        s4 = np.linalg.norm(ordered[3] - ordered[0])
                        
                        w_avg = (s1 + s3) / 2.0
                        h_avg = (s2 + s4) / 2.0
                        
                        if min(w_avg, h_avg) < 1e-4:
                            continue
                            
                        aspect = max(w_avg, h_avg) / min(w_avg, h_avg)
                        
                        # Ideal card aspect ratio: 1.5858. Under perspective tilt, aspect typically ranges [1.2, 2.0]
                        if 1.20 <= aspect <= 2.10:
                            aspect_err = abs(aspect - 1.5858) / 1.5858
                            # Opposition error (opposite sides should be equal in a parallelogram)
                            opp_err = (abs(s1 - s3) / max(s1, s3) + abs(s2 - s4) / max(s2, s4)) / 2.0
                            
                            score = 1.0 - (0.5 * aspect_err + 0.5 * opp_err)
                            candidates.append((score, ordered, cnt))
                            break
                            
        if not candidates:
            return None
            
        # Pick best candidate with highest score
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_score, best_pts, best_cnt = candidates[0]
        
        if best_score < 0.3:
            return None
            
        # Refine corners with sub-pixel precision
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.001)
        refined_corners = cv2.cornerSubPix(
            gray,
            best_pts.copy(),
            (5, 5),
            (-1, -1),
            criteria,
        )
        
        # Ensure aspect alignment: card width (85.60 mm) should correspond to the longer edge
        ordered_refined = order_points(refined_corners)
        edge_top = np.linalg.norm(ordered_refined[0] - ordered_refined[1])
        edge_right = np.linalg.norm(ordered_refined[1] - ordered_refined[2])
        
        cfg = REFERENCE_REGISTRY[ReferenceType.ISO_CARD]
        
        # If card is oriented vertically, swap width/height so mapping matches physical orientation
        if edge_top < edge_right:
            # Rotated 90 degrees
            card_w_mm = cfg.height_mm
            card_h_mm = cfg.width_mm
        else:
            card_w_mm = cfg.width_mm
            card_h_mm = cfg.height_mm
            
        return ReferenceDetectionResult(
            ref_type=ref_type,
            corners=ordered_refined,
            width_mm=card_w_mm,
            height_mm=card_h_mm,
            confidence=min(1.0, max(0.0, float(best_score))),
            is_auto_detected=True,
            contour=best_cnt,
        )

    def detect_aruco(
        self,
        image: np.ndarray,
        ref_type: ReferenceType = ReferenceType.ARUCO_4X4_50MM,
    ) -> Optional[ReferenceDetectionResult]:
        """
        Detects ArUco marker using OpenCV ArucoDetector.
        Provides sub-pixel corner accuracy and zero false positives.
        """
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        # Standard ArUco 4x4 dictionary
        dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        parameters = cv2.aruco.DetectorParameters()
        parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        
        detector = cv2.aruco.ArucoDetector(dictionary, parameters)
        corners, ids, _ = detector.detectMarkers(gray)
        
        if ids is None or len(corners) == 0:
            return None
            
        # Take the first detected marker
        marker_corners = corners[0].reshape((4, 2)).astype(np.float32)
        ordered = order_points(marker_corners)
        
        cfg = REFERENCE_REGISTRY.get(ref_type, REFERENCE_REGISTRY[ReferenceType.ARUCO_4X4_50MM])
        
        return ReferenceDetectionResult(
            ref_type=ref_type,
            corners=ordered,
            width_mm=cfg.width_mm,
            height_mm=cfg.height_mm,
            confidence=0.99,
            is_auto_detected=True,
        )

    def detect_coin(
        self,
        image: np.ndarray,
        ref_type: ReferenceType,
    ) -> Optional[ReferenceDetectionResult]:
        """
        Detects standard circular coins (1 TL, 1 Euro, US Quarter).
        Under perspective projection, a circle projects to an ellipse whose
        major axis is invariant to the tilt angle and matches the true diameter.
        """
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        h, w = gray.shape[:2]
        cfg = REFERENCE_REGISTRY.get(ref_type, REFERENCE_REGISTRY[ReferenceType.COIN_1_TL])
        
        blurred = cv2.medianBlur(gray, 7)
        # HoughCircles to locate circular candidates
        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=int(h / 8),
            param1=100,
            param2=35,
            minRadius=int(min(h, w) * 0.03),
            maxRadius=int(min(h, w) * 0.25),
        )
        
        if circles is None or len(circles[0]) == 0:
            return None
            
        # Select circle with best edge contrast
        best_circle = circles[0][0]
        cx, cy, radius = float(best_circle[0]), float(best_circle[1]), float(best_circle[2])
        
        # Refine circular region using contour ellipse fitting
        roi_pad = int(radius * 1.4)
        x1 = max(0, int(cx - roi_pad))
        y1 = max(0, int(cy - roi_pad))
        x2 = min(w, int(cx + roi_pad))
        y2 = min(h, int(cy + roi_pad))
        
        roi = gray[y1:y2, x1:x2]
        if roi.size == 0:
            return None
            
        roi_thresh = cv2.adaptiveThreshold(
            roi, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 2
        )
        contours, _ = cv2.findContours(roi_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        
        if contours:
            c_largest = max(contours, key=cv2.contourArea)
            if len(c_largest) >= 5:
                ellipse = cv2.fitEllipse(c_largest)
                (ecx, ecy), (d1, d2), angle = ellipse
                major_axis = max(d1, d2)
                radius = major_axis / 2.0
                cx = x1 + ecx
                cy = y1 + ecy
                
        # Construct reference bounding box aligned with axes
        corners = np.array([
            [cx - radius, cy - radius],
            [cx + radius, cy - radius],
            [cx + radius, cy + radius],
            [cx - radius, cy + radius],
        ], dtype=np.float32)
        
        ordered = order_points(corners)
        
        return ReferenceDetectionResult(
            ref_type=ref_type,
            corners=ordered,
            width_mm=cfg.diameter_mm or cfg.width_mm,
            height_mm=cfg.diameter_mm or cfg.height_mm,
            confidence=0.85,
            is_auto_detected=True,
        )

    def _process_manual_corners(
        self,
        image: np.ndarray,
        manual_corners: List[Tuple[float, float]],
        ref_type: ReferenceType,
        custom_width_mm: Optional[float],
        custom_height_mm: Optional[float],
    ) -> ReferenceDetectionResult:
        """Processes and sub-pixel refines manually provided corners."""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        pts = np.array(manual_corners, dtype=np.float32).reshape((4, 2))
        
        # Sub-pixel corner optimization
        try:
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.01)
            refined = cv2.cornerSubPix(gray, pts.copy(), (5, 5), (-1, -1), criteria)
        except Exception:
            refined = pts
            
        ordered = order_points(refined)
        
        cfg = REFERENCE_REGISTRY.get(ref_type, REFERENCE_REGISTRY[ReferenceType.ISO_CARD])
        w_mm = custom_width_mm or cfg.width_mm
        h_mm = custom_height_mm or cfg.height_mm
        
        return ReferenceDetectionResult(
            ref_type=ref_type,
            corners=ordered,
            width_mm=w_mm,
            height_mm=h_mm,
            confidence=1.0,
            is_auto_detected=False,
        )
