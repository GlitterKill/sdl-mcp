// Phase 2 Task 2.4.1 fixture — trait default method dispatch.
// `A` implements `Greeter` but does not override `greet`, so the call
// `a.greet()` must resolve to `Greeter::greet`.

trait Greeter {
    fn greet(&self) {
        println!("hi");
    }
}

struct A;

impl Greeter for A {}

fn use_a() {
    let a = A;
    a.greet();
}
