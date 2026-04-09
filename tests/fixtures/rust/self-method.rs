// Phase 2 Task 2.4.3 fixture — `Self::method` inside an impl block
// must resolve to the enclosing impl's method table.

struct A;

impl A {
    fn helper() {}

    fn caller() {
        Self::helper();
    }
}
