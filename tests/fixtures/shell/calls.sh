#!/usr/bin/env bash

# Function definitions
hello_world() {
    echo "Hello, World!"
}

greet_user() {
    local name="$1"
    echo "Greetings, $name!"
}

calculate() {
    echo $(($1 + $2))
}

process_data() {
    echo "Processing data"
}

# Function that calls other functions
orchestrate() {
    hello_world
    greet_user "Test"
    calculate 1 2
}

# Aliases
alias ll='ls -la'
alias grep='grep --color=auto'
alias gitlog='git log --oneline'

# ===== FUNCTION CALLS =====

# Basic function call (no arguments)
hello_world

# Function call with arguments
greet_user "Alice"
greet_user "Bob" "Welcome"

# Function call with numeric arguments
calculate 5 3

# Function call in expression
local sum=$(calculate 10 20)

# Function call in pipeline
calculate 1 2 | cat

# Function call in subshell
(calculate 3 4)

# ===== EXTERNAL COMMANDS =====

# Basic external command
ls

# Command with arguments
ls -la

# Command with multiple arguments
grep "pattern" file.txt

# Piped commands
cat file.txt | grep "pattern" | wc -l

# Command with redirection
echo "test" > output.txt

# Command with quotes
echo "Hello, World!"

# Command with options
git log --oneline --all

# ===== ALIAS INVOCATIONS =====

# Alias invocation (should be detected as dynamic call)
ll

# Alias with additional arguments
ll /tmp

# Alias invocation in pipeline
ll | grep "pattern"

# ===== COMPOSITE COMMANDS =====

# Function call followed by external command
hello_world
echo "Done"

# External command followed by function call
echo "Starting..."
process_data

# Multiple function calls
hello_world
greet_user "Test"
calculate 1 2

# Nested subshells with calls
$(hello_world)
$(echo "Nested" | grep "Nested")

# ===== CONDITIONAL CALLS =====

# Function call in if condition
if calculate 1 2 > /dev/null; then
    echo "Success"
fi

# Function call in while loop
while calculate 1 2 > /dev/null; do
    break
done

# ===== ARRAY COMMANDS =====

# Command with array expansion
for file in $(ls); do
    echo "$file"
done

# ===== SPECIAL FORMS =====

# Command substitution with function call
result=$(calculate 5 7)

# Background function call
process_data &

# ===== GLOBAL SCOPE CALLS =====
# Calls outside any function (global scope)
echo "Global script start"
hello_world
ls -la
greet_user "Global"
calculate 100 200
echo "Global script end"
