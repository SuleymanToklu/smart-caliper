"""
Configuration module for SmartCaliper.

Defines physical reference standards (ISO cards, coinage, ArUco markers),
metrology tolerances, visual styling parameters, and algorithmic thresholds.
"""

from enum import Enum
from typing import Optional, Tuple
from pydantic import BaseModel, Field


class ReferenceType(str, Enum):
    """Supported physical reference targets for perspective rectification."""
    ISO_CARD = "iso_card"               # ISO/IEC 7810 ID-1 standard (85.60 x 53.98 mm)
    COIN_1_TL = "coin_1_tl"             # Turkish 1 Lira (Diameter: 26.15 mm)
    COIN_50_KURUS = "coin_50_kurus"     # Turkish 50 Kurus (Diameter: 23.85 mm)
    COIN_1_EURO = "coin_1_euro"         # 1 Euro coin (Diameter: 23.25 mm)
    COIN_2_EURO = "coin_2_euro"         # 2 Euro coin (Diameter: 25.75 mm)
    COIN_US_QUARTER = "coin_us_quarter" # US Quarter 25¢ (Diameter: 24.26 mm)
    COIN_US_DIME = "coin_us_dime"       # US Dime 10¢ (Diameter: 17.91 mm)
    ARUCO_4X4_50MM = "aruco_4x4_50mm"   # ArUco DICT_4X4_50 (50.00 x 50.00 mm)
    CUSTOM_RECT = "custom_rect"         # Custom user-defined rectangle (width x height mm)
    CUSTOM_CIRCLE = "custom_circle"     # Custom user-defined circle (diameter mm)


class ReferenceConfig(BaseModel):
    """Physical properties of a calibration target."""
    ref_type: ReferenceType
    name: str
    width_mm: float = Field(..., description="Physical width in millimeters")
    height_mm: float = Field(..., description="Physical height in millimeters")
    diameter_mm: Optional[float] = Field(None, description="Diameter in mm if circular")
    aspect_ratio: float = Field(..., description="Width / Height aspect ratio")
    is_circular: bool = False
    aruco_dict_id: Optional[int] = None
    aruco_marker_id: Optional[int] = None


# Registry of standard physical reference items
REFERENCE_REGISTRY = {
    ReferenceType.ISO_CARD: ReferenceConfig(
        ref_type=ReferenceType.ISO_CARD,
        name="Credit / Bank / ID Card (ISO/IEC 7810 ID-1)",
        width_mm=85.60,
        height_mm=53.98,
        aspect_ratio=85.60 / 53.98,  # ~1.58577
        is_circular=False,
    ),
    ReferenceType.COIN_1_TL: ReferenceConfig(
        ref_type=ReferenceType.COIN_1_TL,
        name="1 Turkish Lira (1 TL)",
        width_mm=26.15,
        height_mm=26.15,
        diameter_mm=26.15,
        aspect_ratio=1.0,
        is_circular=True,
    ),
    ReferenceType.COIN_50_KURUS: ReferenceConfig(
        ref_type=ReferenceType.COIN_50_KURUS,
        name="50 Turkish Kurus (50 Krs)",
        width_mm=23.85,
        height_mm=23.85,
        diameter_mm=23.85,
        aspect_ratio=1.0,
        is_circular=True,
    ),
    ReferenceType.COIN_1_EURO: ReferenceConfig(
        ref_type=ReferenceType.COIN_1_EURO,
        name="1 Euro Coin (€1)",
        width_mm=23.25,
        height_mm=23.25,
        diameter_mm=23.25,
        aspect_ratio=1.0,
        is_circular=True,
    ),
    ReferenceType.COIN_2_EURO: ReferenceConfig(
        ref_type=ReferenceType.COIN_2_EURO,
        name="2 Euro Coin (€2)",
        width_mm=25.75,
        height_mm=25.75,
        diameter_mm=25.75,
        aspect_ratio=1.0,
        is_circular=True,
    ),
    ReferenceType.COIN_US_QUARTER: ReferenceConfig(
        ref_type=ReferenceType.COIN_US_QUARTER,
        name="US Quarter (25¢)",
        width_mm=24.26,
        height_mm=24.26,
        diameter_mm=24.26,
        aspect_ratio=1.0,
        is_circular=True,
    ),
    ReferenceType.COIN_US_DIME: ReferenceConfig(
        ref_type=ReferenceType.COIN_US_DIME,
        name="US Dime (10¢)",
        width_mm=17.91,
        height_mm=17.91,
        diameter_mm=17.91,
        aspect_ratio=1.0,
        is_circular=True,
    ),
    ReferenceType.ARUCO_4X4_50MM: ReferenceConfig(
        ref_type=ReferenceType.ARUCO_4X4_50MM,
        name="ArUco Marker 4x4 (50 mm)",
        width_mm=50.00,
        height_mm=50.00,
        aspect_ratio=1.0,
        is_circular=False,
        aruco_dict_id=0,  # DICT_4X4_50
    ),
}


class MetrologySettings(BaseModel):
    """Algorithmic tuning parameters for computer vision metrology pipeline."""
    # Target resolution for rectified image (pixels per mm)
    target_ppm: float = 10.0  # 10.0 px/mm means 0.1 mm/pixel resolution
    
    # Preprocessing
    clahe_clip_limit: float = 2.0
    clahe_tile_grid: Tuple[int, int] = (8, 8)
    gaussian_blur_ksize: Tuple[int, int] = (5, 5)
    
    # Sub-pixel parameters
    subpixel_win_size: Tuple[int, int] = (5, 5)
    subpixel_zero_zone: Tuple[int, int] = (-1, -1)
    subpixel_gradient_sample_count: int = 7
    
    # Segmentation
    min_object_area_mm2: float = 5.0    # Filter out dust/specs below 5 mm^2
    max_object_area_ratio: float = 0.85 # Filter out full scene borders
    morphology_kernel_size: int = 3
    
    # CAD Annotation Style
    cad_line_thickness: int = 2
    cad_color_cyan: Tuple[int, int, int] = (255, 240, 0)      # BGR: Neon Cyan
    cad_color_orange: Tuple[int, int, int] = (0, 153, 255)    # BGR: Engineering Amber
    cad_color_green: Tuple[int, int, int] = (50, 220, 50)     # BGR: Pass Green
    cad_color_red: Tuple[int, int, int] = (50, 50, 240)       # BGR: Fail Red
    cad_color_white: Tuple[int, int, int] = (245, 245, 245)   # BGR: Off-white
    cad_font_scale: float = 0.55
