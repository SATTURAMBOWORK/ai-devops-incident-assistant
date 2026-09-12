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

from schemas import HealthResponse, PredictRequest, PredictResponse, Prediction

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("ml-service")

MODEL_PATH = Path(__file__).parent / "model.joblib"

# How many candidate categories to return. Three matches TOP_K in the Node
# retrieval service, so both halves of the app speak about incidents the same way.
TOP_K = 3

# Below this, the model is guessing rather than recognising. Predictions weaker
# than this are dropped instead of being dressed up as an answer - a confident
# wrong label is worse for an on-call engineer than no label at all.
MIN_CONFIDENCE = 0.10

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
        categories=list(model.named_steps["clf"].classes_) if model else [],
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

    # predict_proba gives a probability for every class, not just the winner.
    # That is the whole reason we can return confidences and runners-up.
    # [0] because we passed a batch of one document.
    probabilities = model.predict_proba([request.logs])[0]
    labels = model.named_steps["clf"].classes_

    ranked = sorted(
        zip(labels, probabilities),
        key=lambda pair: pair[1],
        reverse=True,
    )

    predictions = [
        Prediction(label=label, confidence=round(float(score), 4))
        for label, score in ranked[:TOP_K]
        if score >= MIN_CONFIDENCE
    ]

    logger.info(
        "predicted %s for %d chars of logs",
        predictions[0].label if predictions else "nothing",
        len(request.logs),
    )

    return PredictResponse(
        predictions=predictions,
        # Identifies the algorithm, so a later switch is visible in the response
        # and in the Node logs without redeploying the backend.
        model_version="tfidf-logreg-1.0.0",
    )
