#ifndef SYMBOLS_HPP
#define SYMBOLS_HPP

#include <string>
#include <vector>

namespace MyNamespace {

    namespace InnerNamespace {

        class BaseClass {
        private:
            int value_;

        public:
            BaseClass();
            explicit BaseClass(int value);
            virtual ~BaseClass();

            void publicMethod();
            virtual void virtualMethod();
            virtual void overrideMethod();
        };

        class DerivedClass : public BaseClass {
        private:
            int privateField;

        public:
            DerivedClass();
            explicit DerivedClass(int x, int y);
            ~DerivedClass();

            void overrideMethod() override;

        protected:
            void protectedMethod();
        };

    }

    template<typename T>
    class TemplateClass {
    public:
        TemplateClass();
        ~TemplateClass();

        void setItem(T item);
        T getItem() const;

    private:
        T m_item;
    };

    template<typename Key, typename Value>
    class Map {
    public:
        void insert(const Key& key, const Value& value);
        Value get(const Key& key) const;
    };

}

enum class Color {
    Red,
    Green,
    Blue
};

enum StatusCode {
    OK = 0,
    ERROR = 1,
    TIMEOUT = 2
};

using StringAlias = std::string;

template<typename T>
using Vector = std::vector<T>;

struct Point {
    double x;
    double y;
    double z;

    Point();
    Point(double x, double y, double z);
};

class UtilityClass {
public:
    static int staticMethod();
    static const int CONSTANT = 42;
};

namespace {
    class AnonymousNamespaceClass {
    public:
        void method();
    };
}

inline namespace InlineNamespace {
    class InlineClass {
    public:
        void inlineMethod();
    };
}

#endif // SYMBOLS_HPP
