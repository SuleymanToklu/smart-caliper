"""
Synthetic Scene Generator for Automated Benchmark & Ground-Truth Verification.

Renders 3D perspective-projected scenes containing known physical targets
(ISO cards, coins, ArUco markers, precision machined parts) with exact millimeter
ground-truth dimensions to benchmark sub-pixel accuracy and measurement error.
"""

from typing import Tuple, Dict, Any, List
import numpy as np
import cv2

from smart_caliper.config import REFERENCE_REGISTRY, ReferenceType


def create_synthetic_scene_1(
    output_size: Tuple[int, int] = (1200, 900),
    camera_pitch_deg: float = 25.0,
    camera_yaw_deg: float = 12.0,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """
    Renders a realistic desktop scene containing:
    1. ISO Credit Card (85.60 x 53.98 mm) as reference.
    2. Precision Rectangular Test Bar (Exact Ground Truth: 60.00 x 25.00 mm).
    3. Precision Circular Disk (Exact Ground Truth: Diameter 30.00 mm).

    Applies 3D perspective tilt (pitch & yaw), subtle lighting gradient, and sensor noise.

    Returns:
        (perspective_image_bgr, ground_truth_dict)
    """
    # Canvas in metric space (e.g. 10.0 px per mm)
    canvas_ppm = 8.0
    plane_w_mm = 240.0
    plane_h_mm = 180.0
    
    w_px = int(plane_w_mm * canvas_ppm)
    h_px = int(plane_h_mm * canvas_ppm)
    
    # 1. Base table background: clean light-gray matte workbench with subtle grain
    plane = np.full((h_px, w_px, 3), 225, dtype=np.uint8)
    noise = np.random.normal(0, 3, (h_px, w_px, 3)).astype(np.int16)
    plane = np.clip(plane.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    
    # 2. Draw Reference Object: ISO Credit Card (85.60 x 53.98 mm)
    card_cfg = REFERENCE_REGISTRY[ReferenceType.ISO_CARD]
    card_w_px = int(card_cfg.width_mm * canvas_ppm)
    card_h_px = int(card_cfg.height_mm * canvas_ppm)
    
    card_x = int(30.0 * canvas_ppm)
    card_y = int(35.0 * canvas_ppm)
    
    # Dark blue credit card with gold chip accent
    cv2.rectangle(plane, (card_x, card_y), (card_x + card_w_px, card_y + card_h_px), (130, 45, 20), -1)
    # Card border
    cv2.rectangle(plane, (card_x, card_y), (card_x + card_w_px, card_y + card_h_px), (200, 200, 200), 2)
    # Chip
    chip_x = card_x + int(15 * canvas_ppm)
    chip_y = card_y + int(18 * canvas_ppm)
    cv2.rectangle(plane, (chip_x, chip_y), (chip_x + int(12 * canvas_ppm), chip_y + int(10 * canvas_ppm)), (50, 180, 220), -1)
    
    # Ground truth reference corners in orthographic plane
    ref_corners_flat = np.array([
        [card_x, card_y],
        [card_x + card_w_px, card_y],
        [card_x + card_w_px, card_y + card_h_px],
        [card_x, card_y + card_h_px],
    ], dtype=np.float32)
    
    # 3. Target 1: Precision Rectangular Bar (60.00 mm x 25.00 mm)
    bar_w_mm = 60.00
    bar_h_mm = 25.00
    bar_w_px = int(bar_w_mm * canvas_ppm)
    bar_h_px = int(bar_h_mm * canvas_ppm)
    
    bar_x = int(140.0 * canvas_ppm)
    bar_y = int(40.0 * canvas_ppm)
    
    # Dark metallic grey machined bar
    cv2.rectangle(plane, (bar_x, bar_y), (bar_x + bar_w_px, bar_y + bar_h_px), (45, 50, 55), -1)
    cv2.rectangle(plane, (bar_x, bar_y), (bar_x + bar_w_px, bar_y + bar_h_px), (20, 20, 20), 2)
    
    # 4. Target 2: Precision Circular Disk (Diameter: 30.00 mm)
    disk_diam_mm = 30.00
    disk_radius_px = int((disk_diam_mm / 2.0) * canvas_ppm)
    disk_cx = int(170.0 * canvas_ppm)
    disk_cy = int(120.0 * canvas_ppm)
    
    # Anodized orange aluminum disk
    cv2.circle(plane, (disk_cx, disk_cy), disk_radius_px, (30, 90, 210), -1)
    cv2.circle(plane, (disk_cx, disk_cy), disk_radius_px, (15, 45, 120), 2)
    # Center hole (Diameter: 8.00 mm)
    cv2.circle(plane, (disk_cx, disk_cy), int(4.0 * canvas_ppm), (225, 225, 225), -1)
    
    # 5. Apply 3D Perspective Projection (Simulating Smartphone Camera Tilt)
    # Define source corners of the planar table
    src_plane_corners = np.array([
        [0.0, 0.0],
        [w_px, 0.0],
        [w_px, h_px],
        [0.0, h_px],
    ], dtype=np.float32)
    
    # Target corners tilted with pitch and yaw
    out_w, out_h = output_size
    pad_top_x = out_w * 0.18
    pad_bot_x = out_w * 0.04
    pad_top_y = out_h * 0.12
    pad_bot_y = out_h * 0.06
    
    dst_persp_corners = np.array([
        [pad_top_x + 30.0, pad_top_y],
        [out_w - pad_top_x + 10.0, pad_top_y + 15.0],
        [out_w - pad_bot_x, out_h - pad_bot_y],
        [pad_bot_x, out_h - pad_bot_y - 20.0],
    ], dtype=np.float32)
    
    H_3d = cv2.getPerspectiveTransform(src_plane_corners, dst_persp_corners)
    tilted_scene = cv2.warpPerspective(
        plane,
        H_3d,
        (out_w, out_h),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(190, 190, 195),
    )
    
    # Project ground truth reference corners into the tilted camera view
    pts_ref = ref_corners_flat.reshape((-1, 1, 2))
    tilted_ref_corners = cv2.perspectiveTransform(pts_ref, H_3d).reshape((-1, 2))
    
    ground_truth = {
        "reference": {
            "type": "iso_card",
            "width_mm": card_cfg.width_mm,
            "height_mm": card_cfg.height_mm,
            "tilted_corners": tilted_ref_corners.tolist(),
        },
        "target_1_bar": {
            "length_mm": bar_w_mm,
            "width_mm": bar_h_mm,
            "area_mm2": bar_w_mm * bar_h_mm,
        },
        "target_2_disk": {
            "diameter_mm": disk_diam_mm,
            "area_mm2": np.pi * (disk_diam_mm / 2.0)**2 - np.pi * 4.0**2,
        }
    }
    
    return tilted_scene, ground_truth


def create_synthetic_scene_coin(
    output_size: Tuple[int, int] = (1200, 900),
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """
    Renders a scene with a 1 TL coin reference and a machined hex bracket.
    """
    canvas_ppm = 8.0
    w_px = int(240.0 * canvas_ppm)
    h_px = int(180.0 * canvas_ppm)
    
    plane = np.full((h_px, w_px, 3), 215, dtype=np.uint8)
    
    # Coin (1 TL, Diameter: 26.15 mm)
    coin_diam_mm = 26.15
    coin_r_px = int((coin_diam_mm / 2.0) * canvas_ppm)
    coin_cx = int(50.0 * canvas_ppm)
    coin_cy = int(90.0 * canvas_ppm)
    
    # Outer silver ring
    cv2.circle(plane, (coin_cx, coin_cy), coin_r_px, (180, 180, 180), -1)
    cv2.circle(plane, (coin_cx, coin_cy), coin_r_px, (140, 140, 140), 2)
    # Inner gold core
    cv2.circle(plane, (coin_cx, coin_cy), int(coin_r_px * 0.68), (50, 185, 225), -1)
    
    # Target part: 45.00 x 22.00 mm rectangular bracket
    bracket_w_mm = 45.00
    bracket_h_mm = 22.00
    bx = int(130.0 * canvas_ppm)
    by = int(75.0 * canvas_ppm)
    bw = int(bracket_w_mm * canvas_ppm)
    bh = int(bracket_h_mm * canvas_ppm)
    
    cv2.rectangle(plane, (bx, by), (bx + bw, by + bh), (35, 35, 40), -1)
    
    # Perspective tilt
    out_w, out_h = output_size
    src_corners = np.array([[0, 0], [w_px, 0], [w_px, h_px], [0, h_px]], dtype=np.float32)
    dst_corners = np.array([[out_w*0.12, out_h*0.1], [out_w*0.88, out_h*0.12], [out_w*0.95, out_h*0.9], [out_w*0.05, out_h*0.88]], dtype=np.float32)
    
    H = cv2.getPerspectiveTransform(src_corners, dst_corners)
    tilted = cv2.warpPerspective(plane, H, (out_w, out_h), flags=cv2.INTER_LANCZOS4, borderValue=(180, 180, 185))
    
    gt = {
        "reference": {"type": "coin_1_tl", "diameter_mm": coin_diam_mm},
        "target": {"length_mm": bracket_w_mm, "width_mm": bracket_h_mm},
    }
    return tilted, gt


if __name__ == "__main__":
    img, gt = create_synthetic_scene_1()
    cv2.imwrite("sample_scene.png", img)
    print("Synthetic scene generated with GT:", gt)
