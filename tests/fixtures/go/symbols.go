package main

import "fmt"
import "os"

// MyType is a custom type
type MyType struct {
    Name string
    Age  int
}

// MyOtherType is another custom type
type MyOtherType interface {
    DoSomething()
}

// unexportedType is not exported
type unexportedType struct {
    value int
}

const MaxRetries = 3

const (
    DefaultTimeout = 30
    MaxConnections = 100
)

const unexportedConst = 42

var GlobalVar string

var (
    ConfigVar1 string
    ConfigVar2 int
)

var unexportedVar float64

func Add(a int, b int) int {
    return a + b
}

func multiply(x int, y int) int {
    return x * y
}

func GetUserData(id int) (string, error) {
    return "John Doe", nil
}

func ProcessMultiple() (string, int, error) {
    return "result", 42, nil
}

func VariadicFunc(nums ...int) int {
    sum := 0
    for _, n := range nums {
        sum += n
    }
    return sum
}

func (m MyType) DoSomething() {
    fmt.Println(m.Name)
}

func (m MyType) GetValue() int {
    return m.Age
}

func (m *MyType) SetValue(age int) {
    m.Age = age
}

func (m *MyType) internalMethod() {
    fmt.Println("internal")
}

func main() {
    fmt.Println("Hello, World!")
}
