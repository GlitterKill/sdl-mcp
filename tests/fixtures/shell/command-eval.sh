#!/bin/bash
greet() {
  echo "hi"
}
caller() {
  command greet
  eval "greet"
}
