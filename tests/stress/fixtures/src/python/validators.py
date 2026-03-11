"""
Validators — secondary Python fixture (imports from data_processor).
Provides validation functions for data records.
"""

from data_processor import DataRecord, DataProcessor, validate_input


class ValidationError(Exception):
    """Raised when validation fails."""

    def __init__(self, field: str, message: str) -> None:
        self.field = field
        super().__init__(f"Validation error on '{field}': {message}")


class RecordValidator:
    """Validates DataRecord instances against configurable rules."""

    def __init__(self, max_value: float = 1_000_000, max_tags: int = 20) -> None:
        self.max_value = max_value
        self.max_tags = max_tags
        self._errors: list[ValidationError] = []

    def validate(self, record: DataRecord) -> bool:
        self._errors.clear()

        if not record.id or not record.id.strip():
            self._errors.append(ValidationError("id", "must not be empty"))

        if record.value < 0:
            self._errors.append(ValidationError("value", "must be non-negative"))
        elif record.value > self.max_value:
            self._errors.append(
                ValidationError("value", f"exceeds maximum {self.max_value}")
            )

        if len(record.tags) > self.max_tags:
            self._errors.append(
                ValidationError("tags", f"exceeds maximum {self.max_tags} tags")
            )

        return len(self._errors) == 0

    def get_errors(self) -> list[ValidationError]:
        return list(self._errors)


@validate_input(lambda x: isinstance(x, list))
def validate_batch(
    records: list[DataRecord], validator: RecordValidator | None = None
) -> dict:
    """Validate a batch of records and return a summary."""
    v = validator or RecordValidator()
    valid_count = 0
    invalid_ids: list[str] = []

    for record in records:
        if v.validate(record):
            valid_count += 1
        else:
            invalid_ids.append(record.id)

    return {
        "total": len(records),
        "valid": valid_count,
        "invalid": len(invalid_ids),
        "invalid_ids": invalid_ids,
    }


def sanitize_record(record: DataRecord) -> DataRecord:
    """Sanitize a record by clamping values and trimming tags."""
    return DataRecord(
        id=record.id.strip(),
        value=max(0, min(record.value, 1_000_000)),
        tags=[t.strip().lower() for t in record.tags[:20]],
        metadata={k: v for k, v in record.metadata.items() if isinstance(k, str)},
    )
