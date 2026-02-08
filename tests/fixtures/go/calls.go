package main

import "fmt"
import "time"

func Add(a int, b int) int {
    return a + b
}

type MyType struct {
    Value int
}

func (m MyType) Method1() {
    fmt.Println(m.Value)
}

func (m *MyType) Method2(val int) {
    m.Value = val
}

func ProcessData() {
    Add(1, 2)

    t := MyType{Value: 10}
    t.Method1()

    fmt.Println("message")
    time.Sleep(1000)

    go Add(3, 4)

    defer fmt.Println("cleanup")

    go t.Method2(20)

    defer Add(5, 6)
}

func main() {
    ProcessData()
}
