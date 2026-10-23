"""FastAPI microservice called by the Go orchestrator.

Run:  uvicorn main:app --port 8000
"""
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

# Load the adjacent .env before anything reads the environment, regardless of cwd.
load_dotenv(Path(__file__).with_name(".env"), override=True)

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from evaluator import Verdict, evaluate

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ai-judge")

app = FastAPI(title="AI Escrow Judge")

if not (os.getenv("GEMINI_API_KEY") or "").strip():
    log.warning("GEMINI_API_KEY is not set; evaluation requests will fail until configured")
log.info("model=%s", os.getenv("LLM_MODEL", "gemini-3.8-flash"))


class EvaluateRequest(BaseModel):
    requirement: str = Field(min_length=1, max_length=5_000)
    submission: str = Field(min_length=1, max_length=20_000)


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/evaluate", response_model=Verdict)
async def evaluate_endpoint(req: EvaluateRequest) -> Verdict:
    try:
        verdict = await evaluate(req.requirement, req.submission)
    except Exception as exc:  # LLM down, invalid output after retries, rate limit...
        log.exception("evaluation failed")
        # Fail closed: never invent a verdict. The Go backend retries on 502
        # and must not touch the contract until it gets a valid response.
        # Surface the upstream status/body (e.g. 401 bad key, 404 unknown model, 429 rate limit)
        # so the Go backend's error message says what actually went wrong.
        detail = f"evaluation failed: {type(exc).__name__}"
        status = getattr(exc, "status_code", None)
        body = getattr(exc, "body", None)
        if status is not None:
            detail += f" (upstream status {status})"
        if body:
            detail += f": {str(body)[:300]}"
        log.error(detail)
        raise HTTPException(status_code=502, detail=detail) from exc

    log.info("decision=%s reasoning=%s", verdict.decision, verdict.reasoning)
    return verdict
