"""
End-to-End Metrology Pipeline Coordinator.

Chains together Reference Detection, Homography Rectification, Foreground Segmentation,
Sub-pixel Edge Metrology, and CAD Blueprint Annotation Rendering.
"""

from typing import List, Tuple, Optional, Dict, Any
from dataclasses import dataclass
import numpy as np
import cv2

from smart_caliper.config import ReferenceType, MetrologySettings
from smart_caliper.core.homography import rectify_image, transform_points, order_points
from smart_caliper.core.reference import ReferenceDetector, ReferenceDetectionResult
from smart_caliper.core.segmentation import segment_foreground_objects
from smart_caliper.core.metrology import MetrologyCalculator, ObjectMeasurement, ToleranceSpec


@dataclass
class PipelineResult:
    """Comprehensive output of the SmartCaliper inspection pipeline."""
    original_image: np.ndarray
    rectified_image: np.ndarray
    annotated_image: np.ndarray
    measurements: List[ObjectMeasurement]
    reference: ReferenceDetectionResult
    homography_matrix: np.ndarray
    inverse_homography: np.ndarray
    ppm: float
    resolution_mm_per_pixel: float
    origin_offset: Tuple[float, float]
    
    def to_dict(self) -> Dict[str, Any]:
        """Serializes results for REST API response and JSON export."""
        measurements_list = []
        for m in self.measurements:
            box_orig = []
            if m.box_corners_px is not None and len(m.box_corners_px) == 4 and self.inverse_homography is not None:
                try:
                    pts_orig = transform_points(m.box_corners_px, self.inverse_homography)
                    box_orig = [{"x": round(float(p[0]), 1), "y": round(float(p[1]), 1)} for p in pts_orig]
                except Exception:
                    box_orig = []

            centroid_orig = None
            if m.centroid_px is not None and self.inverse_homography is not None:
                try:
                    c_pts = transform_points(np.array([m.centroid_px]), self.inverse_homography)
                    centroid_orig = {"x": round(float(c_pts[0][0]), 1), "y": round(float(c_pts[0][1]), 1)}
                except Exception:
                    centroid_orig = None

            measurements_list.append({
                "id": m.object_id,
                "centroid_mm": {"x": m.centroid_mm[0], "y": m.centroid_mm[1]},
                "centroid_original": centroid_orig,
                "box_corners_original": box_orig,
                "dimensions_mm": {
                    "length": m.length_mm,
                    "width": m.width_mm,
                    "aspect_ratio": m.aspect_ratio,
                    "orientation_deg": m.orientation_deg,
                },
                "area_mm2": m.area_mm2,
                "perimeter_mm": m.perimeter_mm,
                "equivalent_diameter_mm": m.equivalent_diameter_mm,
                "circle_metrics": {
                    "is_circular": m.is_circular,
                    "diameter_mm": m.circle_diameter_mm,
                    "center_mm": {"x": m.circle_center_mm[0], "y": m.circle_center_mm[1]} if m.circle_center_mm else None,
                    "fit_rmse_mm": m.circle_fit_rmse_mm,
                },
                "caliper_feret_mm": {
                    "max_span": m.max_feret_diameter_mm,
                    "min_gap": m.min_feret_diameter_mm,
                },
                "form_factors": {
                    "circularity": m.circularity,
                    "solidity": m.solidity,
                    "defect_score": m.defect_score,
                },
                "qa_inspection": {
                    "passed": m.qa_passed,
                    "message": m.qa_message,
                } if m.qa_passed is not None else None,
            })

        return {
            "calibration": {
                "reference_type": self.reference.ref_type.value,
                "reference_width_mm": self.reference.width_mm,
                "reference_height_mm": self.reference.height_mm,
                "confidence": round(float(self.reference.confidence), 3),
                "is_auto_detected": self.reference.is_auto_detected,
                "pixels_per_mm": round(float(self.ppm), 3),
                "resolution_mm_per_pixel": round(float(self.resolution_mm_per_pixel), 4),
                "canvas_width_px": int(self.rectified_image.shape[1]),
                "canvas_height_px": int(self.rectified_image.shape[0]),
            },
            "objects_count": len(self.measurements),
            "measurements": measurements_list
        }


class CaliperPipeline:
    """Production coordinator for image acquisition, calibration, and metrology inspection."""

    def __init__(self, settings: Optional[MetrologySettings] = None):
        self.settings = settings or MetrologySettings()
        self.ref_detector = ReferenceDetector()

    def process(
        self,
        image: np.ndarray,
        reference_type: ReferenceType = ReferenceType.ISO_CARD,
        manual_corners: Optional[List[Tuple[float, float]]] = None,
        custom_width_mm: Optional[float] = None,
        custom_height_mm: Optional[float] = None,
        tolerance: Optional[ToleranceSpec] = None,
    ) -> PipelineResult:
        """
        Executes complete metrology analysis on an input image.
        """
        if image is None or image.size == 0:
            raise ValueError("Input image is invalid or empty.")
            
        # 1. Reference target localization
        ref_res = self.ref_detector.detect(
            image=image,
            ref_type=reference_type,
            manual_corners=manual_corners,
            custom_width_mm=custom_width_mm,
            custom_height_mm=custom_height_mm,
        )
        
        # 2. Perspective Rectification (Homography warping)
        rect_img, H_total, H_inv, effective_ppm, origin_offset, validity_mask = rectify_image(
            image=image,
            src_quad=ref_res.corners,
            target_width_mm=ref_res.width_mm,
            target_height_mm=ref_res.height_mm,
            target_ppm=self.settings.target_ppm,
            expand_scene=True,
        )
        
        # 3. Transform reference corners to rectified coordinate space
        ref_corners_rect = transform_points(ref_res.corners, H_total)
        
        # 4. Foreground Object Segmentation
        min_px = self.settings.min_object_area_mm2 * (effective_ppm ** 2)
        contours = segment_foreground_objects(
            rectified_image=rect_img,
            ref_corners_in_rect=ref_corners_rect,
            validity_mask=validity_mask,
            min_area_px=min_px,
            max_area_ratio=self.settings.max_object_area_ratio,
        )
        
        # 5. Precision Metrology Measurements
        gray_rect = cv2.cvtColor(rect_img, cv2.COLOR_BGR2GRAY)
        calculator = MetrologyCalculator(ppm=effective_ppm)
        
        measurements: List[ObjectMeasurement] = []
        for idx, cnt in enumerate(contours, start=1):
            m = calculator.analyze_object(
                gray_image=gray_rect,
                contour=cnt,
                object_id=idx,
                tolerance=tolerance,
            )
            measurements.append(m)
            
        # 6. Render CAD Blueprint Technical Drawing
        annotated = self._render_cad_overlay(
            rectified_image=rect_img.copy(),
            ref_corners_rect=ref_corners_rect,
            reference_result=ref_res,
            measurements=measurements,
            ppm=effective_ppm,
        )
        
        return PipelineResult(
            original_image=image,
            rectified_image=rect_img,
            annotated_image=annotated,
            measurements=measurements,
            reference=ref_res,
            homography_matrix=H_total,
            inverse_homography=H_inv,
            ppm=effective_ppm,
            resolution_mm_per_pixel=1.0 / effective_ppm,
            origin_offset=origin_offset,
        )

    def _render_cad_overlay(
        self,
        rectified_image: np.ndarray,
        ref_corners_rect: np.ndarray,
        reference_result: ReferenceDetectionResult,
        measurements: List[ObjectMeasurement],
        ppm: float,
    ) -> np.ndarray:
        """
        Renders an engineering CAD blueprint overlay:
        - Dimension lines with dimension arrows and metric millimeter callouts.
        - Centerlines and crosshairs.
        - Distinct color coding for reference target, verified parts, and tolerances.
        """
        img = rectified_image.copy()
        h, w = img.shape[:2]
        
        # Visual color palette (BGR)
        COLOR_REF = (255, 230, 0)       # Cyan for reference
        COLOR_DIM = (0, 165, 255)       # Engineering Amber for dimensions
        COLOR_PASS = (40, 220, 80)      # Green
        COLOR_FAIL = (40, 40, 240)      # Red
        COLOR_TEXT = (245, 245, 245)    # Bright White
        COLOR_BG = (15, 20, 30)         # Dark HUD background
        
        # 1. Draw Reference Object Frame
        ref_pts = ref_corners_rect.astype(np.int32)
        cv2.polylines(img, [ref_pts], isClosed=True, color=COLOR_REF, thickness=2, lineType=cv2.LINE_AA)
        
        # Corner markers on reference
        for pt in ref_pts:
            cv2.circle(img, tuple(pt), 4, COLOR_REF, -1, lineType=cv2.LINE_AA)
            
        ref_tl = ref_pts[0]
        cv2.putText(
            img,
            f"REF: {reference_result.width_mm:.1f}x{reference_result.height_mm:.1f} mm",
            (ref_tl[0], max(20, ref_tl[1] - 8)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            COLOR_REF,
            1,
            cv2.LINE_AA,
        )
        
        # 2. Draw Measured Objects
        for m in measurements:
            # Color depending on QA inspection
            box_color = COLOR_DIM
            if m.qa_passed is not None:
                box_color = COLOR_PASS if m.qa_passed else COLOR_FAIL
                
            # Draw Rotated Bounding Box
            box = m.box_corners_px.astype(np.int32)
            cv2.polylines(img, [box], isClosed=True, color=box_color, thickness=2, lineType=cv2.LINE_AA)
            
            # Draw Centroid Crosshair
            cx, cy = int(round(m.centroid_px[0])), int(round(m.centroid_px[1]))
            cross_size = 8
            cv2.line(img, (cx - cross_size, cy), (cx + cross_size, cy), COLOR_DIM, 1, cv2.LINE_AA)
            cv2.line(img, (cx, cy - cross_size), (cx, cy + cross_size), COLOR_DIM, 1, cv2.LINE_AA)
            
            # Dimension callouts: Length & Width
            # Find the midpoint of the top edge and right edge of the bounding box
            ordered_box = order_points(m.box_corners_px)
            p0, p1, p2, p3 = ordered_box
            
            # Top edge dimension line (Length or Width)
            edge1_len_mm = np.linalg.norm(p1 - p0) / ppm
            edge2_len_mm = np.linalg.norm(p2 - p1) / ppm
            
            # Badge text
            if m.is_circular and m.circle_diameter_mm:
                text_dim = f"ID#{m.object_id} Ø {m.circle_diameter_mm:.1f} mm"
                # Draw fitted circle
                if m.circle_center_mm:
                    cv2.circle(img, (cx, cy), int(round((m.circle_diameter_mm * ppm) / 2.0)), box_color, 1, cv2.LINE_AA)
            else:
                text_dim = f"ID#{m.object_id} {m.length_mm:.1f} x {m.width_mm:.1f} mm"
                
            # Label background pill for high contrast readability
            label_pos = (int(p0[0]), max(22, int(p0[1]) - 10))
            (tw, th), _ = cv2.getTextSize(text_dim, cv2.FONT_HERSHEY_SIMPLEX, 0.52, 1)
            cv2.rectangle(
                img,
                (label_pos[0] - 3, label_pos[1] - th - 4),
                (label_pos[0] + tw + 6, label_pos[1] + 4),
                COLOR_BG,
                -1,
            )
            cv2.rectangle(
                img,
                (label_pos[0] - 3, label_pos[1] - th - 4),
                (label_pos[0] + tw + 6, label_pos[1] + 4),
                box_color,
                1,
            )
            cv2.putText(
                img,
                text_dim,
                label_pos,
                cv2.FONT_HERSHEY_SIMPLEX,
                0.52,
                COLOR_TEXT,
                1,
                cv2.LINE_AA,
            )
            
        # 3. Metric Scale Bar (Bottom Left)
        scale_len_mm = 20.0
        scale_len_px = int(round(scale_len_mm * ppm))
        sb_x, sb_y = 30, h - 30
        
        if sb_x + scale_len_px < w - 20:
            # Dark background panel for scale bar
            cv2.rectangle(img, (sb_x - 10, sb_y - 25), (sb_x + scale_len_px + 70, sb_y + 15), COLOR_BG, -1)
            cv2.rectangle(img, (sb_x - 10, sb_y - 25), (sb_x + scale_len_px + 70, sb_y + 15), (70, 80, 95), 1)
            # Scale bar line
            cv2.line(img, (sb_x, sb_y), (sb_x + scale_len_px, sb_y), (255, 255, 255), 3, cv2.LINE_AA)
            cv2.line(img, (sb_x, sb_y - 5), (sb_x, sb_y + 5), (255, 255, 255), 2, cv2.LINE_AA)
            cv2.line(img, (sb_x + scale_len_px, sb_y - 5), (sb_x + scale_len_px, sb_y + 5), (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(
                img,
                f"{int(scale_len_mm)} mm (1 mm = {ppm:.1f} px)",
                (sb_x + scale_len_px + 10, sb_y + 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (220, 220, 220),
                1,
                cv2.LINE_AA,
            )
            
        return img
