"""Vision cascade — barcode -> label/OCR -> food-vision, testable in isolation."""

from .identify import IdentifyResult, identify

__all__ = ["identify", "IdentifyResult"]
