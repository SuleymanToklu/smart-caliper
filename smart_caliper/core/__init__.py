"""
Core Computer Vision & Metrology Modules for SmartCaliper.
"""

from smart_caliper.core.homography import (
    order_points,
    compute_homography,
    rectify_image,
    transform_points,
    pixel_to_mm,
    mm_to_pixel,
)
from smart_caliper.core.reference import ReferenceDetector, ReferenceDetectionResult
from smart_caliper.core.subpixel import (
    refine_corners_subpixel,
    extract_subpixel_contour,
    fit_circle_subpixel,
)
from smart_caliper.core.segmentation import (
    preprocess_for_segmentation,
    segment_foreground_objects,
)
from smart_caliper.core.metrology import (
    MetrologyCalculator,
    ObjectMeasurement,
    ToleranceSpec,
)

__all__ = [
    "order_points",
    "compute_homography",
    "rectify_image",
    "transform_points",
    "pixel_to_mm",
    "mm_to_pixel",
    "ReferenceDetector",
    "ReferenceDetectionResult",
    "refine_corners_subpixel",
    "extract_subpixel_contour",
    "fit_circle_subpixel",
    "preprocess_for_segmentation",
    "segment_foreground_objects",
    "MetrologyCalculator",
    "ObjectMeasurement",
    "ToleranceSpec",
]
