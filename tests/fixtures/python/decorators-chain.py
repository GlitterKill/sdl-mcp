"""Phase 2 Task 2.1.1 fixture: decorator chain resolution.

`target` is decorated with `my_decorator` defined in the same file.
The Pass-2 resolver must emit a `call` edge from `target` -> `my_decorator`
with strategy `heuristic-only` and resolution `decorator-chain`.
"""


def my_decorator(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper


def another_decorator(arg):
    def decorate(fn):
        return fn

    return decorate


@my_decorator
def target():
    return 1


@another_decorator("x")
def target_with_args():
    return 2


# Built-in decorators like @staticmethod must NOT produce edges (no user
# symbol exists for them).
class Thing:
    @staticmethod
    def static_method():
        return 3
