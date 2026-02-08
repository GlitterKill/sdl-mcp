"""Python test fixture for symbol extraction (ML-C1.1)"""


# Function with params and return hint
def calculate_sum(a: int, b: int) -> int:
    """Calculate the sum of two integers."""
    return a + b


# Function without return hint
def greet(name):
    return f"Hello, {name}!"


# Function with default parameter
def process_data(data: str, encoding: str = "utf-8"):
    return data.encode(encoding)


# Function with type hints and *args, **kwargs
def flexible_function(*args, **kwargs):
    pass


# Private function (starts with underscore)
def _internal_helper():
    return "internal"


# Double underscore private function
def __very_private():
    return "very private"


# Decorated function
@decorator
@another_decorator(param=True)
def decorated_function():
    pass


# Class with inheritance
class Animal:
    def __init__(self, name: str):
        self.name = name

    def speak(self):
        pass


# Class inheriting from Animal
class Dog(Animal):
    def speak(self) -> str:
        return "Woof!"

    def fetch(self, item: str) -> bool:
        return True


# Private class
class _InternalClass:
    def method(self):
        pass


# Decorated class
@dataclass
class Person:
    name: str
    age: int


# Variable at module level
module_variable = "test"

# Private variable
_private_var = "secret"

# Type alias style (variable)
StringList = list[str]
