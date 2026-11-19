"""Lazy loader for AI Detection.

Model id comes from the `AI_WRITING_DETECTION_MODEL_ID` env var — the service
is deliberately model-agnostic so the Cloud Run container can be swapped to a
different HuggingFace checkpoint without code changes.

Model loads on first request rather than at import. Cloud Run cold-start cost
is intentional — the extension treats a slow first response as normal.

Response shape is decided at load time by inspecting `config.num_labels` and
`config.id2label`, because different detectors expose different heads:

* num_labels == 1 — regression head. Treat the sigmoided output as
  P(AI). Over 0.5 => label "AI"; otherwise "Human".
* num_labels == 2 — binary classification. Pick labels by name if the
  config carries them ("ai", "machine", "generated" => AI; "human" =>
  Human); fall back to index 1 = AI, index 0 = Human.
* num_labels > 2 and labels look ordinal (missing / generic "LABEL_N") —
  treat as an AI-editing scale where index 0 is human-written and the last
  index is fully AI-generated. Confidence is the expected-value on that
  scale, so a concentrated LABEL_0 reads as high-confidence Human and a
  concentrated last label reads as high-confidence AI.
* num_labels > 2 with informative labels — multiclass. Return the
  highest-scoring label name and its softmax probability as confidence.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from dataclasses import dataclass

import torch
from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

log = logging.getLogger("bonsai.detector")

MODEL_ID = os.getenv("AI_WRITING_DETECTION_MODEL_ID", "").strip()
MAX_TOKENS = 512
AI_KEYWORDS = ("ai", "machine", "generated", "edited", "edit")
HUMAN_KEYWORDS = ("human", "original", "unedited")


@dataclass
class DetectorResult:
    label: str
    confidence: float


class Detector:
    """Thread-safe singleton wrapping the HF model.

    `ensure_loaded` is idempotent and blocks concurrent first-callers on a
    single load so cold-start issues one download, not N.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._tokenizer = None
        self._model = None
        self._num_labels = 0
        self._id2label: dict[int, str] = {}
        # Routing mode decided at load time from the config. One of:
        # "regression" | "binary" | "multiclass".
        self._mode = "binary"
        # For binary mode: which logit index corresponds to AI/Human.
        self._ai_index = 1
        self._human_index = 0

    def ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            if not MODEL_ID:
                raise RuntimeError(
                    "AI_WRITING_DETECTION_MODEL_ID is not set — the detector is "
                    "model-agnostic and requires an explicit HF checkpoint id"
                )
            token = os.getenv("HF_TOKEN") or None
            log.info("loading detector model %s (hf_token=%s)", MODEL_ID, bool(token))
            config = AutoConfig.from_pretrained(MODEL_ID, token=token)
            self._num_labels = int(getattr(config, "num_labels", 1) or 1)
            raw_id2label = getattr(config, "id2label", None) or {}
            self._id2label = {int(k): str(v) for k, v in raw_id2label.items()}
            log.info(
                "detector config: num_labels=%s id2label=%s",
                self._num_labels,
                self._id2label,
            )

            if self._num_labels == 1:
                self._mode = "regression"
            elif self._num_labels == 2:
                self._mode = "binary"
                self._ai_index, self._human_index = self._pick_binary_indices()
            elif self._labels_look_ordinal():
                self._mode = "ordinal"
            else:
                self._mode = "multiclass"

            self._tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, token=token)
            self._model = AutoModelForSequenceClassification.from_pretrained(
                MODEL_ID, token=token
            )
            self._model.eval()
            self._loaded = True
            log.info("detector ready (mode=%s)", self._mode)

    def _labels_look_ordinal(self) -> bool:
        """True when id2label is empty or every value is HF's placeholder
        `LABEL_<n>`. In that case the label order carries no meaning beyond
        index, so we treat it as an ordinal 0..N AI-ness scale."""
        if not self._id2label:
            return True
        for name in self._id2label.values():
            if not name.lower().startswith("label_"):
                return False
        return True

    def _pick_binary_indices(self) -> tuple[int, int]:
        ai_idx = -1
        human_idx = -1
        for idx, name in self._id2label.items():
            low = name.lower()
            if ai_idx < 0 and any(kw in low for kw in AI_KEYWORDS):
                ai_idx = idx
            if human_idx < 0 and any(kw in low for kw in HUMAN_KEYWORDS):
                human_idx = idx
        if ai_idx < 0 and human_idx < 0:
            return 1, 0
        if ai_idx < 0:
            ai_idx = 1 - human_idx
        if human_idx < 0:
            human_idx = 1 - ai_idx
        return ai_idx, human_idx

    @torch.inference_mode()
    def _infer(self, texts: list[str]) -> list[DetectorResult]:
        assert self._tokenizer is not None and self._model is not None
        enc = self._tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=MAX_TOKENS,
            return_tensors="pt",
        )
        logits = self._model(**enc).logits  # (batch, num_labels)
        results: list[DetectorResult] = []
        if self._mode == "regression":
            probs = torch.sigmoid(logits.squeeze(-1))
            for p in probs.tolist():
                if p >= 0.5:
                    results.append(DetectorResult(label="AI", confidence=float(p)))
                else:
                    results.append(DetectorResult(label="Human", confidence=float(1.0 - p)))
            return results
        if self._mode == "binary":
            probs = torch.softmax(logits, dim=-1)
            for row in probs.tolist():
                p_ai = float(row[self._ai_index])
                p_hum = float(row[self._human_index])
                if p_ai >= p_hum:
                    results.append(DetectorResult(label="AI", confidence=p_ai))
                else:
                    results.append(DetectorResult(label="Human", confidence=p_hum))
            return results
        if self._mode == "ordinal":
            probs = torch.softmax(logits, dim=-1)
            denom = max(self._num_labels - 1, 1)
            for row in probs.tolist():
                # Expected AI-ness: 0 for pure index-0, 1 for pure last index.
                ai_score = sum(i / denom * float(p) for i, p in enumerate(row))
                if ai_score >= 0.5:
                    results.append(DetectorResult(label="AI", confidence=ai_score))
                else:
                    results.append(DetectorResult(label="Human", confidence=1.0 - ai_score))
            return results
        # multiclass
        probs = torch.softmax(logits, dim=-1)
        for row in probs.tolist():
            idx = max(range(len(row)), key=lambda i: row[i])
            name = self._id2label.get(idx, f"label_{idx}")
            results.append(DetectorResult(label=name, confidence=float(row[idx])))
        return results

    async def detect(self, texts: list[str]) -> list[DetectorResult]:
        # Guard against empty input before touching the tokenizer.
        if not texts:
            return []
        # Offload the blocking forward pass + load to a worker thread so the
        # event loop stays responsive for health checks during cold start.
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._detect_sync, texts)

    def _detect_sync(self, texts: list[str]) -> list[DetectorResult]:
        self.ensure_loaded()
        # Strip empties but preserve positions so the caller can zip results
        # back to its own ids.
        safe = [t if isinstance(t, str) and t.strip() else "" for t in texts]
        return self._infer(safe)


detector = Detector()
