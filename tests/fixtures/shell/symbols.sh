#!/usr/bin/env bash

# Global variables
GLOBAL_VAR="value"
export EXPORTED_VAR="exported"
readonly READONLY_VAR="readonly"
ARRAY_VAR=(one two three)
ASSOC_VAR=([key1]=value1 [key2]=value2)

# Aliases
alias ll='ls -la'
alias grep='grep --color=auto'
alias gitlog='git log --oneline'

# Function definition style 1: name() {}
hello_world() {
    echo "Hello, World!"
}

# Function definition style 2: function name {}
function greet {
    echo "Greetings!"
}

# Function with parameters
greet_user() {
    local name="$1"
    local greeting="$2"
    echo "$greeting, $name!"
}

# Function with local variables
process_data() {
    local local_var="local"
    local count=0
    
    for item in $ARRAY_VAR; do
        count=$((count + 1))
    done
    
    return $count
}

# Function using global variables
use_globals() {
    echo "Global: $GLOBAL_VAR"
    echo "Exported: $EXPORTED_VAR"
}

# Nested function definition (function inside another)
define_inner() {
    # This is a comment, not a nested function in bash
    # Actual nested functions aren't supported in bash
    echo "This is a regular function"
}

# Function with array parameter
process_array() {
    local arr=("$@")
    echo "Processing ${#arr[@]} elements"
}

# Function with return value
calculate() {
    local result=$(($1 + $2))
    echo $result
}

# Function that calls other functions
orchestrate() {
    hello_world
    greet
    greet_user "Alice" "Welcome"
    local sum=$(calculate 5 3)
    echo "Sum: $sum"
}

# Source other files
source ./utils.sh
. ./helpers.sh
