"""Phase 2 Task 2.1.2 fixture: __init__.py re-exports `Foo` from `.real`."""

from .real import Foo
from .real import helper as helper_alias
