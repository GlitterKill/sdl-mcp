// Test fixture for Rust call extraction

// Simple function calls
fn simple_function(x: i32) -> i32 {
    x + 1
}

fn test_simple_calls() {
    simple_function(5);
    simple_function(10);
}

// Method calls
struct Point {
    x: i32,
    y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }

    pub fn distance(&self) -> i32 {
        (self.x * self.x + self.y * self.y).abs()
    }

    pub fn translate(&mut self, dx: i32, dy: i32) {
        self.x += dx;
        self.y += dy;
    }
}

fn test_method_calls() {
    let mut p = Point::new(0, 0);
    p.distance();
    p.translate(5, 10);
}

// Chained method calls
struct VecWrapper {
    data: Vec<i32>,
}

impl VecWrapper {
    pub fn new() -> Self {
        VecWrapper { data: Vec::new() }
    }

    pub fn push(mut self, value: i32) -> Self {
        self.data.push(value);
        self
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }
}

fn test_chained_calls() {
    let wrapper = VecWrapper::new().push(1).push(2).push(3);
    wrapper.len();
}

// Macro invocations (unresolved)
fn test_macros() {
    println!("Hello, world!");
    println!("Number: {}", 42);
    vec![1, 2, 3, 4, 5];
    vec!["a", "b", "c"];
    assert!(true);
    assert_eq!(1, 1);
    format!("Test {}", "string");
    debug!("Debug message");
}

// Associated function calls with different types
struct Circle {
    radius: f64,
}

impl Circle {
    pub fn from_radius(radius: f64) -> Self {
        Circle { radius }
    }

    pub fn area(&self) -> f64 {
        std::f64::consts::PI * self.radius * self.radius
    }
}

struct Rectangle {
    width: f64,
    height: f64,
}

impl Rectangle {
    pub fn new(width: f64, height: f64) -> Self {
        Rectangle { width, height }
    }

    pub fn area(&self) -> f64 {
        self.width * self.height
    }
}

fn test_associated_functions() {
    let circle = Circle::from_radius(5.0);
    let rect = Rectangle::new(10.0, 20.0);
    circle.area();
    rect.area();
}

// Calls inside other functions
fn helper_function(x: i32) -> i32 {
    x * 2
}

fn outer_function(a: i32, b: i32) -> i32 {
    let doubled_a = helper_function(a);
    let doubled_b = helper_function(b);
    doubled_a + doubled_b
}

// Nested calls
fn test_nested_calls() {
    simple_function(helper_function(5));
    let result = simple_function(simple_function(10));
}

// Trait methods
trait Drawable {
    fn draw(&self);
    fn area(&self) -> f64;
}

struct Square {
    side: f64,
}

impl Drawable for Square {
    fn draw(&self) {
        println!("Drawing square with side {}", self.side);
    }

    fn area(&self) -> f64 {
        self.side * self.side
    }
}

fn test_trait_methods() {
    let square = Square { side: 5.0 };
    square.draw();
    square.area();
}

// Generic associated functions
struct Box<T> {
    value: T,
}

impl<T> Box<T> {
    pub fn new(value: T) -> Self {
        Box { value }
    }

    pub fn get(&self) -> &T {
        &self.value
    }
}

fn test_generic_associated() {
    let boxed_int = Box::new(42);
    let boxed_str = Box::new("hello");
    boxed_int.get();
    boxed_str.get();
}

// Module path calls
mod geometry {
    pub fn calculate_distance(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
        ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt()
    }
}

fn test_module_calls() {
    geometry::calculate_distance(0.0, 0.0, 3.0, 4.0);
}

// Closure calls (tracked as unresolved)
fn test_closures() {
    let add = |a: i32, b: i32| a + b;
    add(1, 2);
    let multiply = |a: i32, b: i32| a * b;
    multiply(3, 4);
}

// Function pointers
type MathOp = fn(i32, i32) -> i32;

fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn subtract(a: i32, b: i32) -> i32 {
    a - b
}

fn apply_operation(op: MathOp, x: i32, y: i32) -> i32 {
    op(x, y)
}

fn test_function_pointers() {
    apply_operation(add, 5, 3);
    apply_operation(subtract, 10, 4);
}

// Async function calls (simulated)
fn async_helper() -> i32 {
    42
}

fn test_async_like_calls() {
    async_helper();
}

// Builder pattern
struct Builder {
    value: i32,
}

impl Builder {
    pub fn new() -> Self {
        Builder { value: 0 }
    }

    pub fn with_value(mut self, value: i32) -> Self {
        self.value = value;
        self
    }

    pub fn build(self) -> i32 {
        self.value
    }
}

fn test_builder_pattern() {
    Builder::new().with_value(10).build();
}

// Self method calls
struct Counter {
    count: i32,
}

impl Counter {
    pub fn new() -> Self {
        Counter { count: 0 }
    }

    pub fn increment(&mut self) {
        self.count += 1;
    }

    pub fn double(&mut self) {
        self.count *= 2;
    }

    pub fn process(&mut self) {
        self.increment();
        self.double();
    }
}

fn test_self_calls() {
    let mut counter = Counter::new();
    counter.process();
}

// Complex nested expression with multiple calls
fn test_complex_expressions() {
    let result = simple_function(helper_function(5)) + helper_function(10);
    println!("Result: {}", result);
}

// Option and Result methods
fn test_option_result() {
    let opt: Option<i32> = Some(5);
    opt.unwrap();
    opt.unwrap_or(0);

    let res: Result<i32, &str> = Ok(10);
    res.unwrap();
    res.unwrap_or(0);
}

// Iterator methods
fn test_iterators() {
    let numbers = vec![1, 2, 3, 4, 5];
    let sum: i32 = numbers.iter().map(|x| x * 2).sum();
    println!("Sum: {}", sum);
}

// String methods
fn test_string_methods() {
    let s = String::from("hello");
    s.len();
    s.to_uppercase();
    s.contains("ell");
}
