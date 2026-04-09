class Base {
  void greet() {}
}

class Derived extends Base {
  void say() {
    greet();
  }
}
