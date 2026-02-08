#include "symbols.hpp"
#include <iostream>
#include <vector>

namespace MyNamespace {

    namespace InnerNamespace {

        BaseClass::BaseClass() {
            std::cout << "BaseClass constructor" << std::endl;
        }

        BaseClass::BaseClass(int value) : value_(value) {
        }

        BaseClass::~BaseClass() {
            std::cout << "BaseClass destructor" << std::endl;
        }

        void BaseClass::publicMethod() {
        }

        void BaseClass::virtualMethod() {
        }

        DerivedClass::DerivedClass() : BaseClass(), privateField(0) {
        }

        DerivedClass::DerivedClass(int x, int y) : BaseClass(x), privateField(y) {
        }

        DerivedClass::~DerivedClass() {
        }

        void DerivedClass::overrideMethod() {
        }

        void DerivedClass::protectedMethod() {
        }

    }

    template<typename T>
    TemplateClass<T>::TemplateClass() : m_item() {
    }

    template<typename T>
    TemplateClass<T>::~TemplateClass() {
    }

    template<typename T>
    void TemplateClass<T>::setItem(T item) {
        m_item = item;
    }

    template<typename T>
    T TemplateClass<T>::getItem() const {
        return m_item;
    }

    template<typename Key, typename Value>
    void Map<Key, Value>::insert(const Key& key, const Value& value) {
    }

    template<typename Key, typename Value>
    Value Map<Key, Value>::get(const Key& key) const {
        return Value();
    }

}

Point::Point() : x(0), y(0), z(0) {
}

Point::Point(double x, double y, double z) : x(x), y(y), z(z) {
}

int UtilityClass::staticMethod() {
    return UtilityClass::CONSTANT;
}

namespace {

    void AnonymousNamespaceClass::method() {
    }

}

namespace InlineNamespace {

    void InlineClass::inlineMethod() {
    }

}

void freeFunction() {
}

template<typename T>
T templateFunction(T value) {
    return value * 2;
}

int main() {
    MyNamespace::InnerNamespace::DerivedClass obj(10, 20);

    obj.publicMethod();
    obj.overrideMethod();

    MyNamespace::TemplateClass<int> templateObj;
    templateObj.setItem(42);
    int item = templateObj.getItem();

    Point p(1.0, 2.0, 3.0);

    int result = templateFunction(21);

    return 0;
}
