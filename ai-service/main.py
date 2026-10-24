"""FastAPI microservice called by the Go orchestrator.

Run:  uvicorn main:app --port 8000
"""
import logging
import os

from dotenv import load_dotenv
load_dotenv(override=True)

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from evaluator import (
    GEMINI_DEFAULT_MODEL, 
    OPENROUTER_DEFAULT_MODEL, 
    Verdict, 
    evaluate, 
    provider_name
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ai-judge")

app = FastAPI(title="AI Escrow Judge")

_provider = provider_name()
if _provider == "ollama":
    _key_name = "OLLAMA_API_KEY"
    _default_model = "gpt-oss:120b"
elif _provider == "openrouter":
    _key_name = "OPENROUTER_API_KEY"
    _default_model = OPENROUTER_DEFAULT_MODEL
else:
    _key_name = "GEMINI_API_KEY"
    _default_model = GEMINI_DEFAULT_MODEL

_key = (os.getenv(_key_name) or "").strip()
if not _key:
    log.warning("%s is NOT set: calls to %s will fail", _key_name, _provider)
else:
    log.info("%s loaded: length=%d, ends with ...%s", _key_name, len(_key), _key[-4:])
    
log.info("provider=%s model=%s", _provider, os.getenv("LLM_MODEL", _default_model))

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
    except Exception as exc:
        log.exception("evaluation failed")
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