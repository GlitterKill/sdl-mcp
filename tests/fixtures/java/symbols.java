package com.example;

import java.util.List;
import java.util.Map;

public class Symbols {
    private String privateField;
    protected int protectedField;
    public double publicField;

    public Symbols() {
        this.privateField = "default";
    }

    private void privateMethod() {
        System.out.println("Private");
    }

    protected void protectedMethod(String param) {
        System.out.println(param);
    }

    public String publicMethod(int a, int b) {
        return a + b;
    }

    public static void staticMethod() {
        System.out.println("Static");
    }
}

interface ExampleInterface {
    void interfaceMethod();
}

enum Status {
    ACTIVE,
    INACTIVE,
    PENDING
}

record Point(int x, int y) {
    public Point {
        if (x < 0 || y < 0) {
            throw new IllegalArgumentException("Coordinates must be non-negative");
        }
    }
}
