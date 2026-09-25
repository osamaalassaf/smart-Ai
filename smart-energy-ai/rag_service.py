"""
Smart Energy AI - RAG (Retrieval-Augmented Generation) Service

Responsibility:
    Knowledge retrieval and contextual explanation ONLY.

    It does NOT replace the Agent, the ML models, the optimizer, the
    Digital Twin simulator or the database. Live operational data stays
    with the Agent and its tools; this module answers "how / why"
    questions from the documents in knowledge/energy/.

Pipeline:
    question -> BM25 retrieval over document sections -> top chunks
             -> answer generation (LLM if configured, extractive otherwise)
             -> {"answer": ..., "sources": [...]}

Design notes:
    - Pure Python retrieval (BM25). No vector database or embedding model
      is required, so the dashboard starts with zero extra dependencies.
    - LLM generation is optional. Configure with environment variables:
          RAG_LLM_PROVIDER   anthropic | openai | none   (default: auto)
          ANTHROPIC_API_KEY  enables provider "anthropic"
          OPENAI_API_KEY     enables provider "openai"
          OPENAI_BASE_URL    optional, any OpenAI-compatible endpoint
          RAG_LLM_MODEL      model name override
      With no key the service still answers, using an extractive summary of
      the retrieved sections, and says so in the response.
    - Every failure is caught and reported as a structured error; the Flask
      dashboard never depends on this module being healthy.
"""

from __future__ import annotations

import math
import os
import re
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
KNOWLEDGE_DIR = Path(os.getenv("RAG_KNOWLEDGE_DIR", BASE_DIR / "knowledge" / "energy"))

# Files that describe the knowledge base itself rather than energy topics.
EXCLUDED_FILES = {"readme.md"}

SUPPORTED_SUFFIXES = {".md", ".txt"}

MAX_CHUNK_CHARS = 1200
TOP_K = 4
MIN_SCORE = 0.8           # below this, a section is not considered relevant
LLM_TIMEOUT_SECONDS = 30

DEFAULT_MODELS = {
    "anthropic": "claude-haiku-4-5-20251001",
    "openai": "gpt-4o-mini",
}

STOPWORDS = set(
    """
    a an and are as at be been but by can could do does for from had has have
    how i if in into is it its may me might more most my no not of on or our
    should so such than that the their them then there these they this those to
    too was we were what when where which while who why will with would you your
    about also any each other over under very just only same both between during
    """.split()
)


# =========================================================
# TEXT PROCESSING
# =========================================================


def _stem(token: str) -> str:
    """Very light suffix stripping so 'reducing' matches 'reduce'."""
    for suffix in ("ations", "ation", "ings", "ing", "ies", "ers", "ed", "es", "s"):
        if len(token) > len(suffix) + 3 and token.endswith(suffix):
            base = token[: -len(suffix)]
            if suffix == "ies":
                return base + "y"
            return base
    return token


def tokenize(text: str) -> List[str]:
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return [_stem(t) for t in tokens if t not in STOPWORDS and len(t) > 1]


def _split_sentences(text: str) -> List[str]:
    """Split prose into sentences; each list item counts as its own sentence."""
    sentences: List[str] = []
    prose: List[str] = []
    bullet: List[str] = []

    def flush():
        if bullet:
            item = " ".join(bullet).strip()
            if item and item[-1] not in ".!?:":
                item += "."
            sentences.append(item)
            bullet.clear()
        if prose:
            joined = re.sub(r"\s+", " ", " ".join(prose)).strip()
            sentences.extend(re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", joined))
            prose.clear()

    for line in text.splitlines():
        item = re.match(r"^\s*(?:[-*]|\d+\.)\s+(.*)$", line)
        if item:
            flush()
            bullet.append(item.group(1).strip())
        elif not line.strip():
            flush()
        elif bullet and line[:1].isspace():
            bullet.append(line.strip())   # wrapped continuation of a list item
        else:
            if bullet:
                flush()
            prose.append(line)
    flush()
    return [s.strip() for s in sentences if len(s.strip()) > 20]


# =========================================================
# DATA STRUCTURES
# =========================================================


@dataclass
class Chunk:
    chunk_id: int
    document: str          # file name
    title: str             # document H1
    section: str           # nearest heading
    text: str
    tokens: List[str] = field(default_factory=list)

    def source_dict(self, score: float, rank: int) -> Dict[str, Any]:
        excerpt = re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", self.text, flags=re.MULTILINE)
        excerpt = re.sub(r"\s+", " ", excerpt).strip()
        if len(excerpt) > 280:
            excerpt = excerpt[:277].rsplit(" ", 1)[0] + "…"
        return {
            "ref": rank,
            "document": self.document,
            "title": self.title,
            "section": self.section,
            "score": round(score, 3),
            "excerpt": excerpt,
        }


# =========================================================
# DOCUMENT LOADING / CHUNKING
# =========================================================


def _chunk_markdown(path: Path, start_id: int) -> List[Chunk]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.splitlines()

    title = path.stem.replace("_", " ").title()
    for line in lines:
        if line.startswith("# "):
            title = line[2:].strip()
            break

    sections: List[tuple[str, List[str]]] = []
    current_heading = title
    buffer: List[str] = []

    for line in lines:
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            if any(b.strip() for b in buffer):
                sections.append((current_heading, buffer))
            current_heading = heading.group(2).strip()
            buffer = []
        else:
            buffer.append(line)
    if any(b.strip() for b in buffer):
        sections.append((current_heading, buffer))

    chunks: List[Chunk] = []
    next_id = start_id
    for heading, body_lines in sections:
        body = "\n".join(body_lines).strip()
        # Split very long sections on paragraph boundaries.
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        piece = ""
        for para in paragraphs:
            if piece and len(piece) + len(para) > MAX_CHUNK_CHARS:
                chunks.append(Chunk(next_id, path.name, title, heading, piece))
                next_id += 1
                piece = ""
            piece = f"{piece}\n\n{para}" if piece else para
        if piece:
            chunks.append(Chunk(next_id, path.name, title, heading, piece))
            next_id += 1

    for chunk in chunks:
        # Headings carry strong topical signal, so they are indexed twice.
        chunk.tokens = tokenize(f"{chunk.title} {chunk.section} {chunk.section} {chunk.text}")
    return chunks


# =========================================================
# BM25 INDEX
# =========================================================


class BM25Index:
    def __init__(self, chunks: List[Chunk], k1: float = 1.5, b: float = 0.75):
        self.chunks = chunks
        self.k1 = k1
        self.b = b
        self.doc_freqs = [Counter(c.tokens) for c in chunks]
        self.doc_lens = [len(c.tokens) for c in chunks]
        self.avg_len = (sum(self.doc_lens) / len(self.doc_lens)) if chunks else 0.0
        df: Counter = Counter()
        for freqs in self.doc_freqs:
            df.update(freqs.keys())
        n = len(chunks)
        self.idf = {
            term: math.log(1 + (n - count + 0.5) / (count + 0.5))
            for term, count in df.items()
        }

    def search(self, query: str, top_k: int = TOP_K) -> List[tuple[Chunk, float]]:
        q_terms = tokenize(query)
        if not q_terms or not self.chunks:
            return []
        scores = []
        for idx, freqs in enumerate(self.doc_freqs):
            score = 0.0
            length_norm = 1 - self.b + self.b * (self.doc_lens[idx] / (self.avg_len or 1))
            for term in set(q_terms):
                tf = freqs.get(term, 0)
                if not tf:
                    continue
                score += self.idf.get(term, 0.0) * (tf * (self.k1 + 1)) / (tf + self.k1 * length_norm)
            if score > 0:
                scores.append((self.chunks[idx], score))
        scores.sort(key=lambda item: item[1], reverse=True)
        return scores[:top_k]


# =========================================================
# LLM PROVIDERS (optional)
# =========================================================


SYSTEM_PROMPT = (
    "You are the knowledge assistant of a Smart Energy AI operations center. "
    "Answer ONLY from the numbered knowledge-base excerpts provided. Cite them "
    "inline as [1], [2] etc. If the excerpts do not contain the answer, say that "
    "the knowledge base does not cover it. Keep answers under 180 words, plain "
    "prose, no headings. If a LIVE OPERATIONAL DATA block is provided, you may "
    "refer to it, but always make clear which statements come from live data and "
    "which come from the knowledge base. Never invent readings, savings or events."
)


def _resolve_provider() -> str:
    configured = os.getenv("RAG_LLM_PROVIDER", "auto").strip().lower()
    if configured in {"none", "off", "disabled", "extractive"}:
        return "none"
    if configured == "anthropic":
        return "anthropic" if os.getenv("ANTHROPIC_API_KEY") else "none"
    if configured == "openai":
        return "openai" if os.getenv("OPENAI_API_KEY") else "none"
    # auto
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    return "none"


def _model_for(provider: str) -> Optional[str]:
    if provider == "none":
        return None
    return os.getenv("RAG_LLM_MODEL") or DEFAULT_MODELS[provider]


def _call_llm(provider: str, model: str, user_prompt: str) -> str:
    import requests  # already in requirements.txt; imported lazily

    if provider == "anthropic":
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 600,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_prompt}],
            },
            timeout=LLM_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        blocks = resp.json().get("content", [])
        return "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()

    if provider == "openai":
        base = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        resp = requests.post(
            f"{base}/chat/completions",
            headers={
                "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 600,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=LLM_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()

    raise ValueError(f"Unknown LLM provider: {provider}")


# =========================================================
# RAG SERVICE
# =========================================================


class RAGService:
    def __init__(self, knowledge_dir: Path = KNOWLEDGE_DIR):
        self.knowledge_dir = Path(knowledge_dir)
        self._lock = threading.Lock()
        self._index: Optional[BM25Index] = None
        self._documents: List[str] = []
        self._load_error: Optional[str] = None

    # ------------------------------------------------------
    # Index management
    # ------------------------------------------------------

    def load(self) -> None:
        with self._lock:
            try:
                if not self.knowledge_dir.exists():
                    raise FileNotFoundError(f"Knowledge folder not found: {self.knowledge_dir}")
                chunks: List[Chunk] = []
                documents: List[str] = []
                for path in sorted(self.knowledge_dir.rglob("*")):
                    if (
                        path.is_file()
                        and path.suffix.lower() in SUPPORTED_SUFFIXES
                        and path.name.lower() not in EXCLUDED_FILES
                    ):
                        chunks.extend(_chunk_markdown(path, start_id=len(chunks)))
                        documents.append(path.name)
                if not chunks:
                    raise ValueError("Knowledge folder contains no indexable documents")
                self._index = BM25Index(chunks)
                self._documents = documents
                self._load_error = None
            except Exception as exc:  # noqa: BLE001 - reported, never raised
                self._index = None
                self._documents = []
                self._load_error = str(exc)

    def _ensure_loaded(self) -> None:
        if self._index is None and self._load_error is None:
            self.load()

    def status(self) -> Dict[str, Any]:
        self._ensure_loaded()
        provider = _resolve_provider()
        return {
            "available": self._index is not None,
            "documents": list(self._documents),
            "chunks": len(self._index.chunks) if self._index else 0,
            "generation": "llm" if provider != "none" else "extractive",
            "provider": provider,
            "model": _model_for(provider),
            "error": self._load_error,
        }

    # ------------------------------------------------------
    # Query
    # ------------------------------------------------------

    def query(
        self,
        question: str,
        live_context: Optional[Dict[str, Any]] = None,
        top_k: int = TOP_K,
    ) -> Dict[str, Any]:
        """
        Answer a question from the knowledge base.

        Returns:
            {
              "answer": str,
              "sources": [ {ref, document, title, section, score, excerpt}, ... ],
              "mode": "llm" | "extractive" | "no_match",
              "provider": str, "model": str | None,
              "live_context": dict | None,   # echoed back, never mixed in
              "notice": str | None
            }
        Raises ValueError for an empty question; any other failure is
        returned as a structured result by the caller (app.py).
        """
        question = (question or "").strip()
        if not question:
            raise ValueError("Question must not be empty.")
        if len(question) > 1000:
            raise ValueError("Question is too long (max 1000 characters).")

        self._ensure_loaded()
        if self._index is None:
            raise RuntimeError(f"Knowledge base unavailable: {self._load_error}")

        hits = [(c, s) for c, s in self._index.search(question, top_k) if s >= MIN_SCORE]
        provider = _resolve_provider()
        model = _model_for(provider)

        if not hits:
            return {
                "answer": (
                    "The knowledge base has no section that covers this question. "
                    "Try asking about HVAC, solar, batteries, EV charging, demand "
                    "response, energy efficiency or how the agent makes decisions."
                ),
                "sources": [],
                "mode": "no_match",
                "provider": provider,
                "model": model,
                "live_context": live_context,
                "notice": None,
            }

        sources = [chunk.source_dict(score, rank) for rank, (chunk, score) in enumerate(hits, start=1)]
        notice = None

        if provider != "none":
            try:
                answer = _call_llm(provider, model, self._build_prompt(question, hits, live_context))
                if answer:
                    return {
                        "answer": answer,
                        "sources": sources,
                        "mode": "llm",
                        "provider": provider,
                        "model": model,
                        "live_context": live_context,
                        "notice": None,
                    }
                notice = "The language model returned an empty answer; showing retrieved text instead."
            except Exception as exc:  # noqa: BLE001
                notice = (
                    "The language model could not be reached "
                    f"({type(exc).__name__}); showing retrieved text instead."
                )

        return {
            "answer": self._extractive_answer(question, hits),
            "sources": sources,
            "mode": "extractive",
            "provider": "none" if notice is None else provider,
            "model": None,
            "live_context": live_context,
            "notice": notice,
        }

    # ------------------------------------------------------
    # Helpers
    # ------------------------------------------------------

    @staticmethod
    def _build_prompt(
        question: str,
        hits: List[tuple[Chunk, float]],
        live_context: Optional[Dict[str, Any]],
    ) -> str:
        parts = ["KNOWLEDGE-BASE EXCERPTS:"]
        for rank, (chunk, _score) in enumerate(hits, start=1):
            parts.append(f"[{rank}] {chunk.title} / {chunk.section}\n{chunk.text}")
        if live_context:
            parts.append("LIVE OPERATIONAL DATA (from the agent, not from the knowledge base):")
            for key, value in live_context.items():
                parts.append(f"- {key}: {value}")
        parts.append(f"QUESTION: {question}")
        return "\n\n".join(parts)

    @staticmethod
    def _extractive_answer(question: str, hits: List[tuple[Chunk, float]]) -> str:
        """Pick the sentences that best overlap the question, keep citation refs."""
        q_terms = set(tokenize(question))
        top_score = hits[0][1] or 1.0
        scored = []
        for rank, (chunk, chunk_score) in enumerate(hits, start=1):
            text = chunk.text
            relevance = chunk_score / top_score  # 1.0 for the best section
            for position, sentence in enumerate(_split_sentences(text)):
                overlap = len(q_terms & set(tokenize(sentence)))
                # Best sections dominate; within them, favour term overlap and
                # earlier sentences (topic sentences come first).
                weight = relevance * 2.0 + overlap * 0.5 - position * 0.08
                if overlap or rank == 1:
                    scored.append((weight, rank, position, sentence))
        if not scored:
            chunk = hits[0][0]
            return f"{_split_sentences(chunk.text)[0] if _split_sentences(chunk.text) else chunk.text} [1]"

        best = sorted(scored, key=lambda s: s[0], reverse=True)[:4]
        best.sort(key=lambda s: (s[1], s[2]))  # restore reading order
        return " ".join(f"{sentence} [{rank}]" for _score, rank, _pos, sentence in best)


# Module-level singleton used by app.py
rag_service = RAGService()


if __name__ == "__main__":
    import json
    import sys

    q = " ".join(sys.argv[1:]) or "Why can reducing HVAC load reduce building energy consumption?"
    print(json.dumps(rag_service.status(), indent=2))
    print(json.dumps(rag_service.query(q), indent=2, ensure_ascii=False))
