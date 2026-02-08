// Public module
pub mod my_module;

// Private module
mod internal;

// Module with inline items
mod inline_mod {
    pub fn inline_function() -> i32 {
        42
    }

    pub struct InlineStruct {
        pub field: i32,
    }
}

// Type alias
pub type UserId = u64;

// Private type alias
type InternalId = i32;

// Generic type alias
pub type Result<T> = std::result::Result<T, Error>;

// Public trait
pub trait Drawable {
    fn draw(&self);
    fn area(&self) -> f64;
}

// Private trait
trait InternalTrait {
    fn internal_method(&self);
}

// Generic trait
pub trait Container<T> {
    fn get(&self, index: usize) -> Option<&T>;
    fn set(&mut self, index: usize, value: T);
}

// Public struct
pub struct Point {
    pub x: f64,
    pub y: f64,
}

// Private struct
struct InternalPoint {
    x: i32,
    y: i32,
}

// Struct with tuple-like fields
pub struct Color(pub u8, pub u8, pub u8);

// Generic struct
pub struct Box<T> {
    contents: T,
}

// Struct with lifetime and generics
pub struct Ref<'a, T: 'a> {
    reference: &'a T,
}

// Struct with visibility specifiers
pub struct VisibilityExample {
    pub public_field: i32,
    private_field: i32,
    pub(crate) crate_field: i32,
}

// Public enum
pub enum Direction {
    North,
    South,
    East,
    West,
}

// Enum with data
pub enum Option<T> {
    Some(T),
    None,
}

// Enum with different variants
pub enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
    ChangeColor(i32, i32, i32),
}

// Private enum
enum InternalEnum {
    A,
    B,
}

// Generic enum
pub enum ResultType<T, E> {
    Ok(T),
    Err(E),
}

// Public function
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

// Private function
fn multiply(x: i32, y: i32) -> i32 {
    x * y
}

// Function with multiple return types
pub fn divide(a: f64, b: f64) -> Result<f64> {
    if b == 0.0 {
        return Err("Division by zero".into());
    }
    Ok(a / b)
}

// Generic function
pub fn identity<T>(value: T) -> T {
    value
}

// Function with lifetime
pub fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() {
        x
    } else {
        y
    }
}

// Function with complex parameters
pub fn process_data<T: Clone>(
    items: Vec<T>,
    callback: impl Fn(&T) -> bool,
) -> Vec<T> {
    items.into_iter().filter(callback).collect()
}

// Impl block for struct
impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    pub fn distance_from_origin(&self) -> f64 {
        (self.x.powi(2) + self.y.powi(2)).sqrt()
    }
}

// Impl block with self types
impl Point {
    pub fn translate(&mut self, dx: f64, dy: f64) {
        self.x += dx;
        self.y += dy;
    }
}

// Impl block for trait
impl Drawable for Point {
    fn draw(&self) {
        println!("Drawing point at ({}, {})", self.x, self.y);
    }

    fn area(&self) -> f64 {
        0.0
    }
}

// Impl for generic type
impl<T> Container<T> for Vec<T> {
    fn get(&self, index: usize) -> Option<&T> {
        self.get(index)
    }

    fn set(&mut self, index: usize, value: T) {
        if index < self.len() {
            self[index] = value;
        }
    }
}

// Impl for enum
impl Direction {
    pub fn opposite(&self) -> Direction {
        match self {
            Direction::North => Direction::South,
            Direction::South => Direction::North,
            Direction::East => Direction::West,
            Direction::West => Direction::East,
        }
    }
}

// Associated functions and constants
impl Point {
    pub const ORIGIN: Point = Point { x: 0.0, y: 0.0 };

    pub fn from_polar(radius: f64, angle: f64) -> Self {
        Point {
            x: radius * angle.cos(),
            y: radius * angle.sin(),
        }
    }
}

// Struct with default visibility
struct DefaultStruct {
    field: i32,
}

// Function with visibility modifiers
pub(crate) fn crate_internal() -> i32 {
    42
}

// Struct with pub(crate) fields
pub struct CrateVisibility {
    pub public: i32,
    pub(crate) crate_visible: i32,
    private: i32,
}
