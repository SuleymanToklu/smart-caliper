"""
Unit tests for Homography & Perspective Rectification.
"""

import pytest
import numpy as np
import cv2

from smart_caliper.core.homography import (
    order_points,
    compute_homography,
    transform_points,
    rectify_image,
    pixel_to_mm,
    mm_to_pixel,
)


def test_order_points_standard():
    # Regular rectangle: TL, TR, BR, BL
    pts = np.array([[0, 0], [100, 0], [100, 50], [0, 50]], dtype=np.float32)
    ordered = order_points(pts)
    assert np.allclose(ordered[0], [0, 0])
    assert np.allclose(ordered[1], [100, 0])
    assert np.allclose(ordered[2], [100, 50])
    assert np.allclose(ordered[3], [0, 50])


def test_order_points_shuffled_and_rotated():
    # Rotated square with points scrambled
    pts = np.array([[50, 0], [100, 50], [50, 100], [0, 50]], dtype=np.float32)
    shuffled = pts[[2, 0, 3, 1]]
    ordered = order_points(shuffled)
    assert len(ordered) == 4
    # Check that points are ordered in clockwise cyclical fashion
    # cross products of consecutive edges should be positive
    v1 = ordered[1] - ordered[0]
    v2 = ordered[2] - ordered[1]
    cross = v1[0] * v2[1] - v1[1] * v2[0]
    assert cross > 0


def test_compute_homography_exact():
    src = np.array([[10, 15], [210, 20], [195, 160], [15, 145]], dtype=np.float32)
    dst = np.array([[0, 0], [200, 0], [200, 150], [0, 150]], dtype=np.float32)
    
    H, _ = compute_homography(src, dst)
    transformed = transform_points(src, H)
    
    assert np.allclose(transformed, dst, atol=1e-2)


def test_pixel_to_mm_conversions():
    ppm = 10.0  # 10 px = 1 mm
    assert pixel_to_mm(100.0, ppm) == 10.0
    assert mm_to_pixel(10.0, ppm) == 100.0
    assert pixel_to_mm(1.0, ppm) == 0.1
    
    with pytest.raises(ValueError):
        pixel_to_mm(10.0, 0.0)


def test_rectify_image_dimensions():
    # 85.60 x 53.98 mm rectangle
    img = np.zeros((400, 600, 3), dtype=np.uint8)
    # Define tilted card quad
    card_quad = np.array([
        [100.0, 80.0],
        [400.0, 100.0],
        [370.0, 280.0],
        [90.0, 240.0],
    ], dtype=np.float32)
    
    rect, H, H_inv, ppm, offset, val_mask = rectify_image(
        image=img,
        src_quad=card_quad,
        target_width_mm=85.60,
        target_height_mm=53.98,
        target_ppm=5.0,
        expand_scene=False,
    )
    assert val_mask is not None
    
    expected_w = int(round(85.60 * 5.0))
    expected_h = int(round(53.98 * 5.0))
    assert rect.shape[1] == expected_w
    assert rect.shape[0] == expected_h
