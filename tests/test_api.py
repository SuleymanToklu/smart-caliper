"""
Test suite for FastAPI REST endpoints and Web Application serving.
"""

import pytest
from fastapi.testclient import TestClient
from smart_caliper.api.app import app

client = TestClient(app)


def test_api_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "online"
    assert data["engine"] == "SmartCaliper"


def test_api_presets():
    response = client.get("/api/presets")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 5
    ids = [p["id"] for p in data]
    assert "iso_card" in ids
    assert "coin_1_tl" in ids


def test_api_samples_list():
    response = client.get("/api/samples")
    assert response.status_code == 200
    samples = response.json()
    assert len(samples) >= 3


def test_api_analyze_sample():
    response = client.post(
        "/api/analyze",
        data={
            "sample_name": "sample_card_inspection.png",
            "ref_type": "iso_card",
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert "calibration" in data
    assert "measurements" in data
    assert "images" in data
    assert "rectified_png_b64" in data["images"]
    assert "cad_annotated_png_b64" in data["images"]
    assert "original_png_b64" in data["images"]
    assert data["objects_count"] >= 1


def test_api_measure_points():
    response = client.post(
        "/api/measure-points",
        json={
            "p1": {"x": 100.0, "y": 100.0},
            "p2": {"x": 200.0, "y": 100.0},
            "ppm": 10.0,
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert data["distance_mm"] == 10.0
    assert data["distance_px"] == 100.0


def test_api_circle_points():
    response = client.post(
        "/api/circle-points",
        json={
            "p1": {"x": 0.0, "y": 50.0},
            "p2": {"x": 50.0, "y": 100.0},
            "p3": {"x": 100.0, "y": 50.0},
            "ppm": 10.0,
        }
    )
    assert response.status_code == 200
    data = response.json()
    assert abs(data["diameter_mm"] - 10.0) < 0.1


def test_web_static_index():
    response = client.get("/")
    assert response.status_code == 200
    assert "SmartCaliper" in response.text
    assert "cadCanvas" in response.text
    assert "webcamVideo" in response.text


def test_api_analyze_file_upload():
    with open("samples/sample_card_inspection.png", "rb") as f:
        file_bytes = f.read()

    response = client.post(
        "/api/analyze",
        files={"file": ("sample_card_inspection.png", file_bytes, "image/png")},
        data={"ref_type": "iso_card"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "images" in data
    assert "original_png_b64" in data["images"]
    assert "rectified_png_b64" in data["images"]
    assert "cad_annotated_png_b64" in data["images"]
    assert "reference_detected_corners_original" in data
    assert len(data["reference_detected_corners_original"]) == 4
