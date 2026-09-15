"""
SmartCaliper - Sub-pixel Computer Vision Metrology & Defect Inspection Engine.

Provides perspective-corrected, sub-millimeter accurate measurements of physical
objects from standard smartphone camera photographs using known reference objects
(ISO credit cards, coins, ArUco markers, or custom dimensions).
"""

__version__ = "1.0.0"
__author__ = "SmartCaliper Engineering Team"

from smart_caliper.config import ReferenceType, ReferenceConfig
from smart_caliper.pipeline import CaliperPipeline, PipelineResult

__all__ = [
    "ReferenceType",
    "ReferenceConfig",
    "CaliperPipeline",
    "PipelineResult",
]
