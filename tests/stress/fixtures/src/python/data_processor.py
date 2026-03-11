"""
Data Processor — primary Python fixture.
Defines classes, decorators, and functions for data transformation.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar
from functools import wraps
import time

T = TypeVar("T")


def timed(func: Callable[..., T]) -> Callable[..., T]:
    """Decorator that measures execution time."""

    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> T:
        start = time.monotonic()
        result = func(*args, **kwargs)
        elapsed = time.monotonic() - start
        wrapper._last_duration = elapsed  # type: ignore
        return result

    wrapper._last_duration = 0.0  # type: ignore
    return wrapper


def validate_input(validator: Callable[[Any], bool]) -> Callable:
    """Decorator that validates the first argument."""

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> T:
            if args and not validator(args[0]):
                raise ValueError(f"Validation failed for {func.__name__}")
            return func(*args, **kwargs)

        return wrapper

    return decorator


@dataclass
class DataRecord:
    id: str
    value: float
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class DataProcessor:
    """Processes and transforms data records."""

    def __init__(self, batch_size: int = 100) -> None:
        self.batch_size = batch_size
        self._records: list[DataRecord] = []
        self._processed_count = 0

    @timed
    def add_records(self, records: list[DataRecord]) -> int:
        self._records.extend(records)
        return len(records)

    @timed
    def process_batch(self) -> list[DataRecord]:
        batch = self._records[: self.batch_size]
        self._records = self._records[self.batch_size :]
        self._processed_count += len(batch)
        return [self._transform(r) for r in batch]

    def _transform(self, record: DataRecord) -> DataRecord:
        return DataRecord(
            id=record.id,
            value=round(record.value * 1.1, 2),
            tags=[t.lower() for t in record.tags],
            metadata={**record.metadata, "processed": True},
        )

    def get_stats(self) -> dict[str, int]:
        return {
            "pending": len(self._records),
            "processed": self._processed_count,
            "batch_size": self.batch_size,
        }

    def clear(self) -> None:
        self._records.clear()
        self._processed_count = 0


def aggregate_values(records: list[DataRecord]) -> dict[str, float]:
    """Compute aggregate statistics over record values."""
    if not records:
        return {"min": 0, "max": 0, "avg": 0, "sum": 0}
    values = [r.value for r in records]
    return {
        "min": min(values),
        "max": max(values),
        "avg": sum(values) / len(values),
        "sum": sum(values),
    }


def filter_by_tags(
    records: list[DataRecord], required_tags: set[str]
) -> list[DataRecord]:
    """Filter records that contain all required tags."""
    return [r for r in records if required_tags.issubset(set(r.tags))]
