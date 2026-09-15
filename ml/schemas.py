"""
Request and response schemas for the ML service.

The Node backend keeps every schema in backend/src/models/. This file is the
same idea for the Python service: the shape of the API lives in one place,
separate from the logic that serves it.

These are Pydantic models. FastAPI uses them three ways at once:
  1. validates incoming JSON and rejects bad requests with a 422 automatically,
  2. converts the validated data into real Python objects,
  3. generates the OpenAPI docs at /docs from them.

So the schema is the contract, the validator and the documentation - written once.
"""

from pydantic import BaseModel, Field


class PredictRequest(BaseModel):
    """What the backend sends us: the raw incident logs."""

    logs: str = Field(
        ...,  # required - no default
        min_length=1,
        # The Node side already caps logs at 50000 characters (see
        # backend/src/models/Incident.js). Matching that limit here means a
        # payload that the database would reject never reaches the model
        # either, and keeps the two services honest about the same contract.
        max_length=50000,
        description="Raw incident logs to classify.",
    )


class Prediction(BaseModel):
    """One candidate category and how confident the model is about it."""

    label: str = Field(description="Runbook category id, e.g. 'oom-killed'.")
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Probability for this category, between 0 and 1.",
    )


class PredictResponse(BaseModel):
    """
    What we send back.

    We deliberately return the top few candidates instead of a single answer.
    A bare label hides how sure the model was - 0.91 and 0.34 would look
    identical to the caller. Returning the runners-up lets the backend decide
    what to do when the model is unsure, and lets the UI show "probably X,
    possibly Y" rather than pretending to certainty it does not have.
    """

    predictions: list[Prediction] = Field(
        description=(
            "Candidate categories, highest confidence first. Empty when the logs "
            "look healthy or the model is not confident enough to name a category."
        )
    )
    model_version: str = Field(
        description="Which trained model produced this, for debugging and audits."
    )


class HealthResponse(BaseModel):
    """
    Answer for GET /health.

    `model_loaded` is the part that matters. A process can be alive and still
    useless if the model file is missing, so the health check reports whether
    the service can actually do its job - not merely whether it is running.
    """

    status: str
    model_loaded: bool
    categories: list[str] = Field(
        default_factory=list,
        description="The labels this model can predict.",
    )
