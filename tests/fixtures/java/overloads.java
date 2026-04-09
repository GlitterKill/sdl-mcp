class C {
  void foo(int a) {}
  void foo(int a, int b) {}
  void caller() {
    foo(1);
    foo(1, 2);
  }
}
