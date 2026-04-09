// Phase 2 Task 2.4.2 fixture — grouped and aliased `use`.
// The grouped `use` binds `foo` directly and `bar as renamed`.

use crate::utils::{foo, bar as renamed};

pub use renamed as reexport_name;
