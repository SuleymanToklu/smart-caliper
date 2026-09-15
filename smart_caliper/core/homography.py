"""
Perspective Rectification & Homography Module.

Solves the projective distortion between the camera sensor plane and the physical
work surface, establishing an orthographic metric plane with known pixels-per-millimeter (PPM).
"""

from typing import Tuple, Optional
import numpy as np
import cv2


def order_points(pts: np.ndarray) -> np.ndarray:
    """
    Orders 4 quadrilateral coordinates in clockwise sequence:
    [Top-Left, Top-Right, Bottom-Right, Bottom-Left].

    Uses geometric centroid and angular sorting to be invariant to arbitrary rotations.
    """
    pts = np.asarray(pts, dtype=np.float32).reshape((4, 2))
    
    # Calculate centroid
    centroid = np.mean(pts, axis=0)
    
    # Calculate polar angles relative to centroid
    angles = np.arctan2(pts[:, 1] - centroid[1], pts[:, 0] - centroid[0])
    
    # Sort points by angle (counter-clockwise from -pi to +pi)
    sort_idx = np.argsort(angles)
    ordered = pts[sort_idx]
    
    # Find the top-left point: point with minimum (x + y)
    tl_idx = np.argmin(ordered[:, 0] + ordered[:, 1])
    
    # Roll array so Top-Left is at index 0, then ensure clockwise order
    ordered = np.roll(ordered, -tl_idx, axis=0)
    
    # Check if orientation is clockwise using 2D cross product of first two edges
    v1 = ordered[1] - ordered[0]
    v2 = ordered[2] - ordered[1]
    cross = v1[0] * v2[1] - v1[1] * v2[0]
    
    if cross < 0:
        # Counter-clockwise -> swap index 1 and 3 to make clockwise
        ordered = ordered[[0, 3, 2, 1]]
        
    return ordered


def compute_homography(
    src_pts: np.ndarray,
    dst_pts: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Computes 3x3 planar homography matrix H mapping src_pts to dst_pts.
    
    Equation:
        P_dst ~ H * P_src
    """
    src = np.asarray(src_pts, dtype=np.float32).reshape((-1, 2))
    dst = np.asarray(dst_pts, dtype=np.float32).reshape((-1, 2))
    
    if len(src) == 4:
        H = cv2.getPerspectiveTransform(src, dst)
        mask = np.ones((4, 1), dtype=np.uint8)
    else:
        H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
        
    return H, mask


def transform_points(pts: np.ndarray, H: np.ndarray) -> np.ndarray:
    """
    Transforms 2D points using 3x3 projective homography matrix H.
    
    P' = [x', y', 1]^T = (H * [x, y, 1]^T) / z'
    """
    pts = np.asarray(pts, dtype=np.float32).reshape((-1, 1, 2))
    transformed = cv2.perspectiveTransform(pts, H)
    return transformed.reshape((-1, 2))


def rectify_image(
    image: np.ndarray,
    src_quad: np.ndarray,
    target_width_mm: float,
    target_height_mm: float,
    target_ppm: float = 10.0,
    expand_scene: bool = True,
    max_canvas_dim: int = 2400,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, float, Tuple[float, float]]:
    """
    Warps image into an orthographic metric plane where:
    - 1 millimeter corresponds to exactly `target_ppm` pixels.
    - Perspective tilt, pitch, and yaw are mathematically eliminated.
    - Entire scene around the reference object is preserved without clipping.

    Parameters:
        image: Original input image (BGR or Gray).
        src_quad: 4 corner points of reference object in original image.
        target_width_mm: Physical width of reference object in mm.
        target_height_mm: Physical height of reference object in mm.
        target_ppm: Desired metric scale (pixels per mm). Default 10.0 px/mm (0.1 mm/px).
        expand_scene: If True, warps full image context; if False, crops to reference ROI.
        max_canvas_dim: Maximum output canvas dimension to prevent OOM on extreme perspective angles.

    Returns:
        rectified_image: Perspective-corrected orthographic image.
        H_total: Combined 3x3 Homography matrix from original image to rectified canvas.
        H_inv: Inverse Homography matrix (rectified canvas back to original).
        effective_ppm: Actual pixels-per-millimeter scale achieved.
        origin_offset: (offset_x, offset_y) translation of the coordinate origin.
    """
    h_orig, w_orig = image.shape[:2]
    src_ordered = order_points(src_quad)
    
    # Reference object dimensions in metric pixel space
    ref_w_px = target_width_mm * target_ppm
    ref_h_px = target_height_mm * target_ppm
    
    # Destination points for the reference object placed at local origin (0, 0)
    dst_ref = np.array([
        [0.0, 0.0],
        [ref_w_px, 0.0],
        [ref_w_px, ref_h_px],
        [0.0, ref_h_px],
    ], dtype=np.float32)
    
    # Initial homography mapping source reference to local (0, 0)
    H_base = cv2.getPerspectiveTransform(src_ordered, dst_ref)
    
    if not expand_scene:
        out_w = int(np.round(ref_w_px))
        out_h = int(np.round(ref_h_px))
        rectified = cv2.warpPerspective(image, H_base, (out_w, out_h), flags=cv2.INTER_LANCZOS4)
        H_inv = np.linalg.inv(H_base)
        val_mask = np.full((out_h, out_w), 255, dtype=np.uint8)
        return rectified, H_base, H_inv, target_ppm, (0.0, 0.0), val_mask
    
    # Project the 4 corners of the entire original image through H_base
    img_corners = np.array([
        [0.0, 0.0],
        [w_orig, 0.0],
        [w_orig, h_orig],
        [0.0, h_orig],
    ], dtype=np.float32).reshape((-1, 1, 2))
    
    warped_corners = cv2.perspectiveTransform(img_corners, H_base).reshape((-1, 2))
    
    # Find bounding box in metric pixel space
    x_min, y_min = np.min(warped_corners, axis=0)
    x_max, y_max = np.max(warped_corners, axis=0)
    
    # Constrain extreme projections to max_canvas_dim while maintaining scale
    span_w = x_max - x_min
    span_h = y_max - y_min
    
    scale_factor = 1.0
    if span_w > max_canvas_dim or span_h > max_canvas_dim:
        scale_factor = min(max_canvas_dim / span_w, max_canvas_dim / span_h)
        
    effective_ppm = target_ppm * scale_factor
    
    # Recompute with scaling
    ref_w_px = target_width_mm * effective_ppm
    ref_h_px = target_height_mm * effective_ppm
    
    dst_ref_scaled = np.array([
        [0.0, 0.0],
        [ref_w_px, 0.0],
        [ref_w_px, ref_h_px],
        [0.0, ref_h_px],
    ], dtype=np.float32)
    
    H_scaled = cv2.getPerspectiveTransform(src_ordered, dst_ref_scaled)
    warped_corners_scaled = cv2.perspectiveTransform(img_corners, H_scaled).reshape((-1, 2))
    
    x_min, y_min = np.min(warped_corners_scaled, axis=0)
    x_max, y_max = np.max(warped_corners_scaled, axis=0)
    
    # Padding of 20 pixels around the perimeter
    pad = 20.0
    out_w = int(np.ceil(x_max - x_min + 2 * pad))
    out_h = int(np.ceil(y_max - y_min + 2 * pad))
    
    # Translation matrix to shift (x_min, y_min) to (pad, pad)
    T = np.array([
        [1.0, 0.0, -x_min + pad],
        [0.0, 1.0, -y_min + pad],
        [0.0, 0.0, 1.0],
    ], dtype=np.float32)
    
    H_total = T @ H_scaled
    H_inv = np.linalg.inv(H_total)
    
    rectified = cv2.warpPerspective(
        image,
        H_total,
        (out_w, out_h),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(18, 18, 22),
    )
    
    # Generate validity mask: 255 inside original image frame, 0 outside
    ones_mask = np.full((h_orig, w_orig), 255, dtype=np.uint8)
    validity_mask = cv2.warpPerspective(
        ones_mask,
        H_total,
        (out_w, out_h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    
    origin_offset = (-x_min + pad, -y_min + pad)
    return rectified, H_total, H_inv, effective_ppm, origin_offset, validity_mask


def pixel_to_mm(dist_px: float, ppm: float) -> float:
    """Converts a pixel distance to physical millimeters."""
    if ppm <= 0:
        raise ValueError(f"Pixels-per-millimeter (PPM) must be positive, got {ppm}")
    return float(dist_px / ppm)


def mm_to_pixel(dist_mm: float, ppm: float) -> float:
    """Converts physical millimeters to pixel distance."""
    return float(dist_mm * ppm)
