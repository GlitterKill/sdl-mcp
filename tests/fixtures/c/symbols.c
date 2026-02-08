#include <stdio.h>
#include <stdlib.h>
#include "symbols.h"

int global_counter = 0;

void simple_function(void) {
    printf("Simple function\n");
}

int add_numbers(int a, int b) {
    return a + b;
}

void* allocate_memory(size_t size) {
    return malloc(size);
}

void process_data(const char* data, int length) {
    for (int i = 0; i < length; i++) {
        printf("%c", data[i]);
    }
    printf("\n");
}

int compute_sum(int* array, int count) {
    int sum = 0;
    for (int i = 0; i < count; i++) {
        sum += array[i];
    }
    return sum;
}

void print_point(Point p) {
    printf("Point(%d, %d)\n", p.x, p.y);
}

Point create_point(int x, int y) {
    Point p;
    p.x = x;
    p.y = y;
    return p;
}

Color get_color(Status status) {
    if (status == STATUS_ACTIVE) {
        return COLOR_RED;
    } else if (status == STATUS_INACTIVE) {
        return COLOR_GREEN;
    } else {
        return COLOR_BLUE;
    }
}

void print_status(Status status) {
    switch (status) {
        case STATUS_ACTIVE:
            printf("Active\n");
            break;
        case STATUS_INACTIVE:
            printf("Inactive\n");
            break;
        case STATUS_PENDING:
            printf("Pending\n");
            break;
    }
}
