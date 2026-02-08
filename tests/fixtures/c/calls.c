#include <stdio.h>
#include <stdlib.h>

int add_numbers(int a, int b) {
    return a + b;
}

void print_message(const char* msg) {
    printf("%s\n", msg);
}

void* allocate_memory(size_t size) {
    return malloc(size);
}

typedef struct {
    int x;
    int y;
} Point;

void print_point(Point* p) {
    printf("Point(%d, %d)\n", p->x, p->y);
}

Point create_point(int x, int y) {
    Point p = {x, y};
    return p;
}

int main() {
    int sum = add_numbers(10, 20);
    print_message("Hello, World!");

    void* ptr = allocate_memory(100);

    Point p = create_point(5, 10);
    print_point(&p);

    Point* pptr = &p;
    print_point(pptr);

    free(ptr);

    return 0;
}
