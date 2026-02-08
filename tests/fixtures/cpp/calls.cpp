#include <iostream>
#include <vector>
#include <string>

class Calculator {
public:
    Calculator(int value) : value_(value) {}

    int add(int x) {
        return value_ + x;
    }

    int multiply(int x) {
        return value_ * x;
    }

private:
    int value_;
};

template<typename T>
class Container {
public:
    Container() : data_() {}

    void add(const T& item) {
        data_.push_back(item);
    }

    T get(int index) const {
        return data_[index];
    }

private:
    std::vector<T> data_;
};

void printMessage(const std::string& msg) {
    std::cout << msg << std::endl;
}

std::string createGreeting(const std::string& name) {
    return "Hello, " + name + "!";
}

int main() {
    Calculator calc(10);

    int sum = calc.add(5);
    int product = calc.multiply(3);

    printMessage("Calculator operations completed");

    std::string greeting = createGreeting("World");
    std::cout << greeting << std::endl;

    Container<int> container;
    container.add(42);
    container.add(100);

    int item = container.get(0);

    Container<std::string> stringContainer;
    stringContainer.add("First");
    stringContainer.add("Second");

    std::string strItem = stringContainer.get(1);

    return 0;
}
