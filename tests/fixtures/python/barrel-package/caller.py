"""Phase 2 Task 2.1.2 fixture: caller imports Foo through the barrel."""

from . import Foo


def use_foo():
    return Foo()
