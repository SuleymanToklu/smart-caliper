"""
Unit tests for Metrology metrics, form factors, and engineering tolerances.
"""

import pytest
import numpy as np
import cv2

from smart_caliper.core.metrology import (
    MetrologyCalculator,
    ToleranceSpec,
)


def test_metrology_calculator_rectangle():
    # 10 px per mm
    ppm = 10.0
    calc = MetrologyCalculator(ppm=ppm)
    
    # Create image with a 40.0 x 20.0 mm rectangle (400 x 200 px)
    img = np.zeros((300, 500), dtype=np.uint8)
    cv2.rectangle(img, (50, 50), (450, 250), 255, -1)
    
    contours, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    assert len(contours) == 1
    
    meas = calc.analyze_object(gray_image=img, contour=contours[0], object_id=1)
    
    # Ground truth: Length = 40.0 mm, Width = 20.0 mm
    assert abs(meas.length_mm - 40.0) < 0.3
    assert abs(meas.width_mm - 20.0) < 0.3
    assert abs(meas.area_mm2 - 800.0) < 20.0
    assert not meas.is_circular
    assert meas.solidity > 0.95


def test_metrology_calculator_circle():
    ppm = 10.0
    calc = MetrologyCalculator(ppm=ppm)
    
    # Create circular disk: Diameter 30.0 mm (radius 150 px)
    img = np.zeros((400, 400), dtype=np.uint8)
    cv2.circle(img, (200, 200), 150, 255, -1)
    
    contours, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    meas = calc.analyze_object(gray_image=img, contour=contours[0], object_id=2)
    
    assert meas.is_circular
    assert meas.circle_diameter_mm is not None
    assert abs(meas.circle_diameter_mm - 30.0) < 0.4
    assert meas.circularity > 0.85


def test_metrology_tolerance_pass_fail():
    ppm = 10.0
    calc = MetrologyCalculator(ppm=ppm)
    
    img = np.zeros((300, 300), dtype=np.uint8)
    cv2.rectangle(img, (50, 50), (250, 150), 255, -1)  # 20.0 x 10.0 mm
    cnts, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    
    # Spec 1: Within tolerance (20.0 +/- 0.5 mm) -> PASS
    spec_pass = ToleranceSpec(nominal_length_mm=20.0, tol_length_mm=0.5)
    meas_pass = calc.analyze_object(img, cnts[0], tolerance=spec_pass)
    assert meas_pass.qa_passed is True
    
    # Spec 2: Strict out of tolerance (25.0 +/- 0.2 mm) -> FAIL
    spec_fail = ToleranceSpec(nominal_length_mm=25.0, tol_length_mm=0.2)
    meas_fail = calc.analyze_object(img, cnts[0], tolerance=spec_fail)
    assert meas_fail.qa_passed is False
