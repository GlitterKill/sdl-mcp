package com.example;

import java.util.List;
import java.util.ArrayList;

public class Calls {
    private String field;

    public Calls(String field) {
        this.field = field;
    }

    public void methodCalls() {
        List<String> list = new ArrayList<>();
        list.add("test");

        list.clear();
        List<String> another = list;
        another.size();

        String result = list.toString().toUpperCase();

        nestedMethod();
    }

    private void nestedMethod() {
        System.out.println("Nested");
    }

    public void staticCalls() {
        Math.abs(-5);
        System.out.println("Static");
    }

    public void chainedCalls() {
        String text = "hello".toUpperCase().trim().substring(0, 1);
    }

    public void thisAndSuper() {
        this.field = "updated";
    }
}

class Parent {
    public Parent() {
        super();
    }

    public void parentMethod() {
        System.out.println("Parent");
    }
}

class Child extends Parent {
    public Child() {
        this("default");
    }

    public Child(String param) {
        super();
        super.parentMethod();
    }

    @Override
    public void parentMethod() {
        super.parentMethod();
    }
}
