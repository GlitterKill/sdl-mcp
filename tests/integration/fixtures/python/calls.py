"""Python test fixture for call extraction (ML-C1.3)"""

# Basic function calls
result = calculate_sum(1, 2)
message = greet("Alice")

# Method calls
obj = MyClass()
obj.method()
another_obj.process(value=42)

# Chained method calls
result = obj.method1().method2().method3()
text = data.strip().lower().replace("x", "y")

# Constructor calls
instance = MyClass()
person = Person(name="Bob", age=30)

# Calls with arguments
process_data("hello", encoding="utf-8")
calculate_sum(a=1, b=2)

# Nested calls
result = calculate_sum(calculate_sum(1, 2), calculate_sum(3, 4))
text = process(calculate(x), calculate(y))

# Async/await-style calls (Python uses await)
data = await fetch_data()  # Python syntax: await expression
processed = await process_data(raw_data)

# Calls with unpacking
values = [1, 2, 3]
calculate_sum(*values)
kwargs = {"a": 1, "b": 2}
calculate_sum(**kwargs)

# Calls in list comprehensions
results = [calculate_sum(x, y) for x, y in pairs]

# Calls in lambdas
processor = lambda x: process(x)
adder = lambda a, b: calculate_sum(a, b)

# Calls as arguments
process(processor(input_data))
calculate_sum(process(a), process(b))

# Built-in function calls
len(data)
str(123)
list(range(10))

# Static method calls
MyClass.static_method()
UtilityClass.helper_function()

# Calls on string literals
"hello".upper()
"test".strip()

# Calls on list literals
[1, 2, 3].append(4)
{"a": 1, "b": 2}.keys()


# Decorator calls (these create call edges)
@decorator
def function1():
    pass


@decorator(param="value")
def function2():
    pass


@decorator1(param1="a") @ decorator2(param2="b")
def function3():
    pass
