// Phase 2 Task 2.4.2 caller fixture — exercises both an unaliased
// grouped import (`foo`) and an alias (`renamed`).

use crate::utils::{foo, bar as renamed};

fn caller() {
    foo();
    renamed();
}
