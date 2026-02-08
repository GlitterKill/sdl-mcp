#ifndef SYMBOLS_H
#define SYMBOLS_H

typedef int StatusCode;
typedef struct Point Point;
typedef enum Status Status;
typedef enum Color Color;

struct Point {
    int x;
    int y;
    const char* label;
};

struct Rectangle {
    Point top_left;
    Point bottom_right;
    int width;
    int height;
};

enum Status {
    STATUS_ACTIVE,
    STATUS_INACTIVE,
    STATUS_PENDING
};

enum Color {
    COLOR_RED,
    COLOR_GREEN,
    COLOR_BLUE
};

typedef struct {
    int id;
    float value;
    char* name;
} CustomData;

typedef struct {
    void* data;
    size_t size;
} Buffer;

typedef int (*Callback)(int value);

void simple_function(void);
int add_numbers(int a, int b);
void* allocate_memory(size_t size);
void process_data(const char* data, int length);
int compute_sum(int* array, int count);
void print_point(Point p);
Point create_point(int x, int y);
Color get_color(Status status);
void print_status(Status status);

extern int global_counter;

#endif
