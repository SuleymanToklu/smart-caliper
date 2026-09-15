"""
Foreground Object Segmentation Module.

Isolates targets from background work surfaces using adaptive thresholding,
color space transformations, and hierarchical contour analysis, while cleanly masking
out the reference calibration target, holes, and background frame artifacts.
"""

from typing import List, Tuple, Optional
import numpy as np
import cv2


def preprocess_for_segmentation(
    bgr_image: np.ndarray,
    clahe_clip_limit: float = 2.0,
    clahe_grid_size: Tuple[int, int] = (8, 8),
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Normalizes lighting across the rectified work surface using CLAHE on the L-channel
    in CIE-LAB color space and edge-preserving bilateral filtering.

    Returns:
        (enhanced_bgr, enhanced_gray)
    """
    lab = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    
    clahe = cv2.createCLAHE(clipLimit=clahe_clip_limit, tileGridSize=clahe_grid_size)
    l_enhanced = clahe.apply(l_channel)
    
    lab_enhanced = cv2.merge((l_enhanced, a_channel, b_channel))
    bgr_enhanced = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)
    gray = cv2.cvtColor(bgr_enhanced, cv2.COLOR_BGR2GRAY)
    
    # Bilateral smoothing preserves sharp object boundaries while flattening table textures
    smoothed = cv2.bilateralFilter(gray, d=7, sigmaColor=50, sigmaSpace=50)
    
    return bgr_enhanced, smoothed


def segment_foreground_objects(
    rectified_image: np.ndarray,
    ref_corners_in_rect: Optional[np.ndarray] = None,
    validity_mask: Optional[np.ndarray] = None,
    min_area_px: float = 100.0,
    max_area_ratio: float = 0.35,
    margin_px: int = 15,
) -> List[np.ndarray]:
    """
    Extracts all physical target objects present in the rectified workspace.

    Uses hierarchical contour decomposition (RETR_CCOMP) to correctly extract objects
    sitting on top of worktables, mats, or sheets, while rejecting the tabletop boundary
    and inner internal holes.
    """
    h, w = rectified_image.shape[:2]
    total_area = h * w
    
    _, gray = preprocess_for_segmentation(rectified_image)
    
    # 1. Base exclusion mask
    exclusion_mask = np.zeros((h, w), dtype=np.uint8)
    
    # Outer margins
    exclusion_mask[:margin_px, :] = 255
    exclusion_mask[-margin_px:, :] = 255
    exclusion_mask[:, :margin_px] = 255
    exclusion_mask[:, -margin_px:] = 255
    
    # Validity mask erosion
    if validity_mask is not None:
        kernel_erode = cv2.getStructuringElement(cv2.MORPH_RECT, (20, 20))
        valid_eroded = cv2.erode(validity_mask, kernel_erode)
        exclusion_mask[valid_eroded == 0] = 255
        
    # Mask out reference object with 15px buffer
    if ref_corners_in_rect is not None and len(ref_corners_in_rect) == 4:
        ref_poly = ref_corners_in_rect.astype(np.int32)
        ref_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(ref_mask, [ref_poly], 255)
        kernel_dil = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
        ref_mask = cv2.dilate(ref_mask, kernel_dil)
        exclusion_mask[ref_mask > 0] = 255
        
    # 2. Extract edge map
    edges = cv2.Canny(gray, 40, 130)
    kernel_close = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges_closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel_close, iterations=1)
    
    # Zero out excluded zones
    edges_closed[exclusion_mask > 0] = 0
    
    # 3. Find 2-level hierarchy contours
    contours, hierarchy = cv2.findContours(edges_closed, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    
    if not contours or hierarchy is None:
        return []
        
    valid_work_area = np.sum(exclusion_mask == 0)
    if valid_work_area <= 0:
        valid_work_area = total_area
        
    raw_candidates = []
    hierarchy = hierarchy[0]
    
    for idx, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        if area < min_area_px or area > (max_area_ratio * valid_work_area):
            continue
            
        bx, by, bw, bh = cv2.boundingRect(cnt)
        # Reject objects that span almost the entire canvas
        if bw > 0.65 * w or bh > 0.65 * h:
            continue
            
        # Check exclusion overlap
        cnt_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(cnt_mask, [cnt], -1, 255, -1)
        overlap = cv2.bitwise_and(cnt_mask, exclusion_mask)
        if np.sum(overlap > 0) > 0.15 * np.sum(cnt_mask > 0):
            continue
            
        # Parent check: in RETR_CCOMP, if hierarchy[idx][3] != -1, this contour is inside another contour
        parent_idx = hierarchy[idx][3]
        if parent_idx != -1:
            parent_area = cv2.contourArea(contours[parent_idx])
            # If parent is an inspected object (not the huge table), this is just an inner hole! Skip hole
            if parent_area < (max_area_ratio * valid_work_area):
                continue
                
        raw_candidates.append((area, bx, by, bw, bh, cnt))
        
    # Deduplicate double contours (e.g. inner vs outer boundary of line strokes with same centroid)
    filtered = []
    raw_candidates.sort(key=lambda x: x[0], reverse=True)
    
    for area, bx, by, bw, bh, cnt in raw_candidates:
        cx, cy = bx + bw / 2.0, by + bh / 2.0
        is_dup = False
        for f_area, f_bx, f_by, f_bw, f_bh, f_cnt in filtered:
            f_cx, f_cy = f_bx + f_bw / 2.0, f_by + f_bh / 2.0
            # If centers are within 10px and bounding boxes are within 15px, it's the same object
            if abs(cx - f_cx) < 12 and abs(cy - f_cy) < 12:
                is_dup = True
                break
        if not is_dup:
            # Fill the contour
            filled = np.zeros((h, w), dtype=np.uint8)
            cv2.drawContours(filled, [cnt], -1, 255, -1)
            solid_cnts, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if solid_cnts:
                filtered.append((area, bx, by, bw, bh, solid_cnts[0]))
                
    # Sort top-to-bottom, left-to-right
    result_contours = [f[5] for f in filtered]
    result_contours.sort(key=lambda c: (cv2.boundingRect(c)[1] // 80, cv2.boundingRect(c)[0]))
    return result_contours
