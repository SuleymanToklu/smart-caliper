"""
Integration tests for End-to-End Metrology Pipeline.
"""

import os
import pytest
import cv2
import numpy as np

from smart_caliper.pipeline import CaliperPipeline
from smart_caliper.config import ReferenceType
from smart_caliper.core.metrology import ToleranceSpec


def test_pipeline_on_card_sample():
    sample_path = "samples/sample_card_inspection.png"
    assert os.path.exists(sample_path), f"Sample {sample_path} must exist"
    
    img = cv2.imread(sample_path)
    assert img is not None
    
    pipeline = CaliperPipeline()
    result = pipeline.process(
        image=img,
        reference_type=ReferenceType.ISO_CARD,
    )
    
    assert result.rectified_image is not None
    assert result.annotated_image is not None
    assert result.ppm > 0.0
    assert result.reference.ref_type == ReferenceType.ISO_CARD
    assert len(result.measurements) >= 1
    
    # Check serialization
    res_dict = result.to_dict()
    assert "calibration" in res_dict
    assert "measurements" in res_dict
    assert res_dict["objects_count"] >= 1


def test_pipeline_on_aruco_sample():
    sample_path = "samples/sample_aruco_components.png"
    assert os.path.exists(sample_path), f"Sample {sample_path} must exist"
    
    img = cv2.imread(sample_path)
    pipeline = CaliperPipeline()
    result = pipeline.process(
        image=img,
        reference_type=ReferenceType.ARUCO_4X4_50MM,
    )
    
    assert result.reference.ref_type == ReferenceType.ARUCO_4X4_50MM
    assert result.reference.confidence > 0.9
    assert len(result.measurements) >= 1
    # Check IC chip measurement is plausible (~40 x 15 mm)
    m = result.measurements[0]
    assert m.length_mm > 20.0
