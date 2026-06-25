#!/usr/bin/env python3
import importlib.metadata
import json
import sys

import tiktoken


DEFAULT_ENCODING = "o200k_base"
DEFAULT_MODEL = "gpt-5.5"


def tokenizer_version():
    try:
        return importlib.metadata.version("tiktoken")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def resolve_encoding(model, fallback_encoding):
    # Prefer the tokenizer table shipped by tiktoken so benchmark costs follow the tested model.
    try:
        return tiktoken.encoding_for_model(model), "encoding_for_model"
    except KeyError:
        return tiktoken.get_encoding(fallback_encoding or DEFAULT_ENCODING), "configured_encoding"


def main():
    payload = json.load(sys.stdin)
    texts = payload.get("texts") or {}
    model = payload.get("model") or payload.get("modelHint") or DEFAULT_MODEL
    fallback_encoding = payload.get("encoding") or DEFAULT_ENCODING
    enc, tokenizer_resolution = resolve_encoding(model, fallback_encoding)
    counts = {key: len(enc.encode(str(value or ""))) for key, value in texts.items()}
    json.dump(
        {
            "counts": counts,
            "model": model,
            "modelHint": model,
            "encoding": enc.name,
            "tokenizerResolution": tokenizer_resolution,
            "tokenizerVersion": tokenizer_version(),
            "tokenizerSource": "tiktoken",
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
