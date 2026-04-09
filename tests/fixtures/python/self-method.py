"""Phase 2 Task 2.1.3 fixture: self.method() scope-walker disambiguation.

Two classes in the same file define a method with the same name (`handle`).
When `Alpha.run` calls `self.handle()`, the resolver must disambiguate via
the scope walker and resolve to `Alpha.handle`, not `Beta.handle`.
"""


class Alpha:
    def handle(self):
        return "alpha"

    def run(self):
        # Should resolve to Alpha.handle, not Beta.handle.
        return self.handle()


class Beta:
    def handle(self):
        return "beta"

    def run(self):
        # Should resolve to Beta.handle.
        return self.handle()
