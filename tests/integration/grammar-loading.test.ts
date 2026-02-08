import { describe, it } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("Grammar Loading Integration Tests (ML-B.1, ML-B.3)", () => {
  describe("Python Grammar", () => {
    it("should load tree-sitter-python grammar", () => {
      const Python = require("tree-sitter-python");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Python);
      }, "Should be able to set Python language");

      const sourceCode = "def hello():\n    print('Hello, World!')\n";
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse Python code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "module",
        "Root node should be module",
      );
    });

    it("should parse basic Python constructs", () => {
      const Python = require("tree-sitter-python");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Python);

      const code = `
class MyClass:
    def __init__(self, value):
        self.value = value
    
    def get_value(self):
        return self.value

def calculate_sum(a, b):
    return a + b

if __name__ == "__main__":
    obj = MyClass(42)
    print(obj.get_value())
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse Python class and function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("Go Grammar", () => {
    it("should load tree-sitter-go grammar", () => {
      const Go = require("tree-sitter-go");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Go);
      }, "Should be able to set Go language");

      const sourceCode =
        'package main\n\nfunc main() {\n    println("Hello, World!")\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse Go code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "source_file",
        "Root node should be source_file",
      );
    });

    it("should parse basic Go constructs", () => {
      const Go = require("tree-sitter-go");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Go);

      const code = `
package main

import "fmt"

type Person struct {
    Name string
    Age  int
}

func (p *Person) Greet() {
    fmt.Printf("Hello, %s!\\n", p.Name)
}

func main() {
    p := &Person{Name: "Alice", Age: 30}
    p.Greet()
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse Go struct and method definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("Java Grammar", () => {
    it("should load tree-sitter-java grammar", () => {
      const Java = require("tree-sitter-java");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Java);
      }, "Should be able to set Java language");

      const sourceCode =
        'public class HelloWorld {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse Java code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "program",
        "Root node should be program",
      );
    });

    it("should parse basic Java constructs", () => {
      const Java = require("tree-sitter-java");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Java);

      const code = `
import java.util.List;
import java.util.ArrayList;

public class Example {
    private String name;
    
    public Example(String name) {
        this.name = name;
    }
    
    public String getName() {
        return this.name;
    }
    
    public List<String> processData() {
        List<String> result = new ArrayList<>();
        result.add(this.name);
        return result;
    }
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse Java class definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("C# Grammar", () => {
    it("should load tree-sitter-c-sharp grammar", () => {
      const CSharp = require("tree-sitter-c-sharp");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(CSharp);
      }, "Should be able to set C# language");

      const sourceCode =
        'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello, World!");\n    }\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse C# code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "compilation_unit",
        "Root node should be compilation_unit",
      );
    });

    it("should parse basic C# constructs", () => {
      const CSharp = require("tree-sitter-c-sharp");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(CSharp);

      const code = `
using System;
using System.Collections.Generic;

public class Person {
    public string Name { get; set; }
    public int Age { get; set; }
    
    public Person(string name, int age) {
        Name = name;
        Age = age;
    }
    
    public void Greet() {
        Console.WriteLine($"Hello, {Name}!");
    }
    
    public List<string> GetNames(List<Person> people) {
        List<string> names = new List<string>();
        foreach (var person in people) {
            names.Add(person.Name);
        }
        return names;
    }
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse C# class definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("C Grammar", () => {
    it("should load tree-sitter-c grammar", () => {
      const C = require("tree-sitter-c");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(C);
      }, "Should be able to set C language");

      const sourceCode =
        '#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse C code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "translation_unit",
        "Root node should be translation_unit",
      );
    });

    it("should parse basic C constructs", () => {
      const C = require("tree-sitter-c");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(C);

      const code = `
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    char name[50];
    int age;
} Person;

void greet(Person* p) {
    printf("Hello, %s!\\n", p->name);
}

int calculate_sum(int a, int b) {
    return a + b;
}

int main() {
    Person p = { "Alice", 30 };
    greet(&p);
    printf("Sum: %d\\n", calculate_sum(5, 3));
    return 0;
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse C struct and function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("C++ Grammar", () => {
    it("should load tree-sitter-cpp grammar", () => {
      const Cpp = require("tree-sitter-cpp");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Cpp);
      }, "Should be able to set C++ language");

      const sourceCode =
        '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse C++ code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "translation_unit",
        "Root node should be translation_unit",
      );
    });

    it("should parse basic C++ constructs", () => {
      const Cpp = require("tree-sitter-cpp");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Cpp);

      const code = `
#include <iostream>
#include <vector>
#include <string>

class Person {
private:
    std::string name;
    int age;

public:
    Person(const std::string& n, int a) : name(n), age(a) {}

    void greet() const {
        std::cout << "Hello, " << name << "!" << std::endl;
    }

    std::string getName() const { return name; }
    int getAge() const { return age; }
};

int calculate_sum(int a, int b) {
    return a + b;
}

int main() {
    Person p("Alice", 30);
    p.greet();
    std::cout << "Sum: " << calculate_sum(5, 3) << std::endl;
    return 0;
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse C++ class and function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("PHP Grammar", () => {
    it("should load tree-sitter-php grammar", () => {
      const PHP = require("tree-sitter-php");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(PHP.php);
      }, "Should be able to set PHP language");

      const sourceCode = '<?php\necho "Hello, World!";\n?>\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse PHP code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "program",
        "Root node should be program",
      );
    });

    it("should parse basic PHP constructs", () => {
      const PHP = require("tree-sitter-php");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(PHP.php);

      const code = `
<?php
class Person {
    private string $name;
    private int $age;

    public function __construct(string $name, int $age) {
        $this->name = $name;
        $this->age = $age;
    }

    public function greet(): void {
        echo "Hello, {$this->name}!" . PHP_EOL;
    }

    public function getName(): string {
        return $this->name;
    }
}

function calculate_sum(int $a, int $b): int {
    return $a + $b;
}

$person = new Person("Alice", 30);
$person->greet();
echo "Sum: " . calculate_sum(5, 3) . PHP_EOL;
?>
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse PHP class and function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("Rust Grammar", () => {
    it("should load tree-sitter-rust grammar", () => {
      const Rust = require("tree-sitter-rust");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Rust);
      }, "Should be able to set Rust language");

      const sourceCode = 'fn main() {\n    println!("Hello, World!");\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse Rust code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "source_file",
        "Root node should be source_file",
      );
    });

    it("should parse basic Rust constructs", () => {
      const Rust = require("tree-sitter-rust");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Rust);

      const code = `
struct Person {
    name: String,
    age: u32,
}

impl Person {
    fn new(name: String, age: u32) -> Self {
        Person { name, age }
    }

    fn greet(&self) {
        println!("Hello, {}!", self.name);
    }

    fn get_name(&self) -> &str {
        &self.name
    }
}

fn calculate_sum(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let p = Person::new(String::from("Alice"), 30);
    p.greet();
    println!("Sum: {}", calculate_sum(5, 3));
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse Rust struct and function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("Kotlin Grammar", () => {
    it("should load tree-sitter-kotlin grammar", () => {
      const Kotlin = require("tree-sitter-kotlin");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Kotlin);
      }, "Should be able to set Kotlin language");

      const sourceCode = 'fun main() {\n    println("Hello, World!")\n}\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse Kotlin code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "source_file",
        "Root node should be source_file",
      );
    });

    it("should parse basic Kotlin constructs", () => {
      const Kotlin = require("tree-sitter-kotlin");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Kotlin);

      const code = `
class Person(val name: String, val age: Int) {
    fun greet() {
        println("Hello, $name!")
    }

    fun getName(): String {
        return name
    }
}

fun calculateSum(a: Int, b: Int): Int {
    return a + b
}

fun main() {
    val p = Person("Alice", 30)
    p.greet()
    println("Sum: \${calculateSum(5, 3)}")
}
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse Kotlin class and function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("Bash Grammar", () => {
    it("should load tree-sitter-bash grammar", () => {
      const Bash = require("tree-sitter-bash");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      assert.doesNotThrow(() => {
        parser.setLanguage(Bash);
      }, "Should be able to set Bash language");

      const sourceCode = '#!/bin/bash\necho "Hello, World!"\n';
      const tree = parser.parse(sourceCode);

      assert.ok(tree, "Should parse Bash code");
      assert.ok(tree.rootNode, "Should have root node");
      assert.strictEqual(
        tree.rootNode.type,
        "program",
        "Root node should be program",
      );
    });

    it("should parse basic Bash constructs", () => {
      const Bash = require("tree-sitter-bash");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Bash);

      const code = `
#!/bin/bash

greet() {
    local name=$1
    echo "Hello, $name!"
}

calculate_sum() {
    local a=$1
    local b=$2
    echo $((a + b))
}

main() {
    local name="Alice"
    local age=30
    
    greet "$name"
    local sum=$(calculate_sum 5 3)
    echo "Sum: $sum"
}

main
`.trim();

      const tree = parser.parse(code);
      assert.ok(tree, "Should parse Bash function definitions");
      assert.strictEqual(
        tree.rootNode.hasError,
        false,
        "Should parse without errors",
      );
    });
  });

  describe("Cross-Language Parser Reuse", () => {
    it("should allow multiple parsers with different languages", () => {
      const Python = require("tree-sitter-python");
      const Go = require("tree-sitter-go");
      const Java = require("tree-sitter-java");
      const CSharp = require("tree-sitter-c-sharp");
      const Parser = require("tree-sitter");

      const pythonParser = new Parser();
      pythonParser.setLanguage(Python);

      const goParser = new Parser();
      goParser.setLanguage(Go);

      const javaParser = new Parser();
      javaParser.setLanguage(Java);

      const csharpParser = new Parser();
      csharpParser.setLanguage(CSharp);

      const pythonTree = pythonParser.parse("x = 1");
      const goTree = goParser.parse("package main\n\nfunc main() {}");
      const javaTree = javaParser.parse("class X {}");
      const csharpTree = csharpParser.parse("class X {}");

      assert.ok(pythonTree, "Should parse Python");
      assert.ok(goTree, "Should parse Go");
      assert.ok(javaTree, "Should parse Java");
      assert.ok(csharpTree, "Should parse C#");
    });

    it("should allow single parser to switch languages", () => {
      const Python = require("tree-sitter-python");
      const Go = require("tree-sitter-go");
      const Parser = require("tree-sitter");

      const parser = new Parser();
      parser.setLanguage(Python);

      const pythonTree = parser.parse("def f(): pass");
      assert.strictEqual(pythonTree.rootNode.type, "module");

      parser.setLanguage(Go);
      const goTree = parser.parse("package main");
      assert.strictEqual(goTree.rootNode.type, "source_file");
    });
  });
});
