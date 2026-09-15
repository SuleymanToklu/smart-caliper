"""
FastAPI Application Entrypoint for SmartCaliper.

Mounts REST API routes, CORS middleware, and serves the mobile-first
interactive CAD Web Application from the static directory.
"""

from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from smart_caliper.api.routes import router

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(
    title="SmartCaliper Metrology Engine",
    description="Sub-pixel Computer Vision Metrology & Defect Inspection Engine",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# Enable CORS for mobile browsers and local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API Router
app.include_router(router)

# Mount Web Application static files
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("smart_caliper.api.app:app", host="0.0.0.0", port=8000, reload=True)
