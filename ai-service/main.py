"""FastAPI microservice called by the Go orchestrator.

Run:  uvicorn main:app --port 8000
"""
import logging
import os

from dotenv import load_dotenv

# Load ai-service/.env BEFORE anything reads the environment. override=True means the file
# wins over any stale OLLAMA_API_KEY left in the shell or in Windows environment variables.
load_dotenv(override=True)

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from evaluator import Verdict, evaluate

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ai-judge")

app = FastAPI(title="AI Escrow Judge")

_key = (os.getenv("OLLAMA_API_KEY") or "").strip()
if not _key:
    log.warning("OLLAMA_API_KEY is NOT set: Ollama Cloud calls will fail with 401")
else:
    # Fingerprint only, so you can confirm WHICH key this process is using.
    log.info("OLLAMA_API_KEY loaded: length=%d, ends with ...%s", len(_key), _key[-4:])
log.info("model=%s base_url=%s", os.getenv("LLM_MODEL", "gpt-oss:120b"),
         os.getenv("OLLAMA_BASE_URL", "https://ollama.com/v1"))


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
