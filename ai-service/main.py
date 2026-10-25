"""FastAPI microservice called by the Go orchestrator.

Run:  uvicorn main:app --port 8000
"""
import logging
import os

from dotenv import load_dotenv

# Load ai-service/.env BEFORE anything reads the environment. override=True means the file
# wins over any stale API key left in the shell or in Windows environment variables.
load_dotenv(override=True)

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from evaluator import OPENROUTER_DEFAULT_MODEL, REVIEWERS, Verdict, evaluate, provider_name

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ai-judge")

app = FastAPI(title="AI Escrow Judge")

_provider = provider_name()
_key_name = "OPENROUTER_API_KEY"
_key = (os.getenv(_key_name) or "").strip()
if not _key:
    log.warning("%s is NOT set: calls to %s will fail", _key_name, _provider)
else:
    log.info("%s loaded", _key_name)
log.info("provider=%s model=%s", _provider,
         os.getenv("LLM_MODEL", OPENROUTER_DEFAULT_MODEL))
for _reviewer, _settings in REVIEWERS.items():
    _key_present = bool((os.getenv(_settings["key"]) or "").strip())
    if _reviewer == "nvidia_nim":
        _key_present = _key_present or bool((os.getenv("NVIDIA_API_KEY") or "").strip())
    if _key_present:
        log.info("reviewer=%s configured model=%s", _reviewer,
                 os.getenv(_settings["model_env"], _settings["model"]))
    else:
        log.warning("reviewer=%s is not configured; evaluations will fail closed", _reviewer)


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
