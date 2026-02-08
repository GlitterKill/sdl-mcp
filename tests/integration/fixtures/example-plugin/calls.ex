fn helperFunction():
  return 42

fn main():
  helperFunction()
  print("Done")

class Calculator:
  fn add(a: int, b: int) -> int:
    return a + b

  fn subtract(a: int, b: int) -> int:
    return a - b

fn useCalculator():
  calc = Calculator()
  calc.add(5, 3)
  calc.subtract(10, 4)
