"""
FastAPI service that serves the trained log classifier.

Run it locally with:
    .venv/Scripts/python.exe -m uvicorn main:app --reload --port 8000

Then open http://localhost:8000/docs for interactive API docs, generated from
the schemas in schemas.py.

This file never trains anything. It loads model.joblib, which train.py produced,
and turns it into an HTTP endpoint. If the model is wrong, you fix it by editing
the dataset and re-running train.py - not by touching this file.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import joblib
from fastapi import FastAPI, HTTPException

from predict import UNKNOWN_LABEL, classify
from schemas import HealthResponse, PredictRequest, PredictResponse, Prediction

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("ml-service")

MODEL_PATH = Path(__file__).parent / "model.joblib"

# How many candidate categories to return. Three matches TOP_K in the Node
# retrieval service, so both halves of the app speak about incidents the same way.
TOP_K = 3

# Bump whenever the algorithm, the categories or the way predictions are made
# changes. Incidents store it (Incident.classification.modelVersion), so without
# a bump, answers from the old 8-category model and this one look identical.
MODEL_VERSION = "tfidf-logreg-windowed-2.2.0"

# Filled in at startup by the lifespan handler below.
state = {"model": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Load the model once, when the process starts.

    Deserialising a scikit-learn pipeline takes real time and memory. Doing it
    per request would add that cost to every call and hold several copies in
    memory at once. Loading at startup also means a missing or corrupt model
    shows up immediately in the logs, not on the first user's request.
    """
    if MODEL_PATH.exists():
        state["model"] = joblib.load(MODEL_PATH)
        labels = list(state["model"].named_steps["clf"].classes_)
        logger.info("Model loaded: %d categories %s", len(labels), labels)
    else:
        # Deliberately not a crash. The service starts, /health honestly reports
        # model_loaded: false, and /predict returns 503. A container that boots
        # and reports itself unhealthy is far easier to diagnose than one stuck
        # in a restart loop.
        logger.error("No model at %s - run train.py first", MODEL_PATH)

    yield  # the app serves requests here

    state["model"] = None


app = FastAPI(
    title="Incident Log Classifier",
    description="Predicts which runbook category a set of incident logs belongs to.",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
def health():
    """
    Liveness and readiness in one endpoint.

    docker-compose and CI use this to decide whether the service is usable, so
    it must never depend on the model actually working - it reports the state,
    it does not assert it.
    """
    model = state["model"]
    return HealthResponse(
        status="ok" if model else "degraded",
        model_loaded=model is not None,
        # "unknown" is how the model says "no incident", not a category anyone
        # can be told about, so it is left out.
        categories=[str(c) for c in model.named_steps["clf"].classes_ if c != UNKNOWN_LABEL]
        if model
        else [],
    )


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest):
    """
    Classify incident logs into runbook categories.

    FastAPI has already validated the body against PredictRequest by the time
    this function runs, so there is no manual input checking here.
    """
    model = state["model"]
    if model is None:
        # 503, not 500: the service is temporarily unable to serve, and the
        # caller may reasonably retry once a model is deployed.
        raise HTTPException(
            status_code=503,
            detail="Model not loaded. Run train.py to generate model.joblib.",
        )

    # Scores the log window by window and applies the confidence floor - the
    # exact function train.py measured, so the accuracy it printed is the
    # accuracy served here. An empty list means healthy or unsure; the backend
    # already treats that as "no prediction".
    predictions = [
        Prediction(label=label, confidence=round(confidence, 4))
        for label, confidence in classify(model, request.logs, top_k=TOP_K)
    ]

    logger.info(
        "predicted %s for %d chars of logs",
        predictions[0].label if predictions else "nothing",
        len(request.logs),
    )

    return PredictResponse(
        predictions=predictions,
        model_version=MODEL_VERSION,
    )
