"""
Unit tests for Sub-pixel Precision Edge & Geometric Fitting.
"""

import pytest
import numpy as np
import cv2

from smart_caliper.core.subpixel import (
    parabolic_peak_subpixel,
    extract_subpixel_contour,
    fit_circle_subpixel,
    refine_corners_subpixel,
)


def test_parabolic_peak_subpixel_exact():
    # Parabola: f(x) = -(x - 0.2)^2 + 10 = -x^2 + 0.4x + 9.96
    # f(-1) = -1 - 0.4 + 9.96 = 8.56
    # f(0) = 9.96
    # f(1) = -1 + 0.4 + 9.96 = 9.36
    # True peak at delta = +0.20
    y_m1 = 8.56
    y_0 = 9.96
    y_p1 = 9.36
    delta = parabolic_peak_subpixel(y_m1, y_0, y_p1)
    assert np.isclose(delta, 0.20, atol=1e-3)


def test_fit_circle_subpixel_perfect():
    # Perfect circle at (120.5, 80.25) with radius 45.75
    theta = np.linspace(0, 2 * np.pi, 60, endpoint=False)
    true_cx, true_cy, true_r = 120.5, 80.25, 45.75
    
    x = true_cx + true_r * np.cos(theta)
    y = true_cy + true_r * np.sin(theta)
    points = np.column_stack([x, y])
    
    fit_cx, fit_cy, fit_r, rmse = fit_circle_subpixel(points)
    
    assert np.isclose(fit_cx, true_cx, atol=1e-3)
    assert np.isclose(fit_cy, true_cy, atol=1e-3)
    assert np.isclose(fit_r, true_r, atol=1e-3)
    assert rmse < 1e-4


def test_fit_circle_subpixel_noisy():
    # Circle with Gaussian jitter +/- 0.5 pixel
    np.random.seed(42)
    theta = np.linspace(0, 2 * np.pi, 80, endpoint=False)
    true_cx, true_cy, true_r = 200.0, 150.0, 35.0
    
    noise = np.random.normal(0, 0.4, (80, 2))
    x = true_cx + true_r * np.cos(theta) + noise[:, 0]
    y = true_cy + true_r * np.sin(theta) + noise[:, 1]
    points = np.column_stack([x, y])
    
    fit_cx, fit_cy, fit_r, rmse = fit_circle_subpixel(points)
    
    # Sub-pixel algebraic fit averages out noise
    assert abs(fit_cx - true_cx) < 0.25
    assert abs(fit_cy - true_cy) < 0.25
    assert abs(fit_r - true_r) < 0.25


def test_extract_subpixel_contour_smooth():
    # Render an anti-aliased disk
    img = np.zeros((100, 100), dtype=np.uint8)
    cv2.circle(img, (50, 50), 25, 255, -1, lineType=cv2.LINE_AA)
    
    contours, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    assert len(contours) > 0
    
    sub_pts = extract_subpixel_contour(img, contours[0])
    assert sub_pts.dtype == np.float32
    assert len(sub_pts) == len(contours[0])
    # Points should not be purely integers
    fractional = np.abs(sub_pts - np.round(sub_pts))
    assert np.max(fractional) > 0.05
