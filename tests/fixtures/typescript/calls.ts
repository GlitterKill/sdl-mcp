import { foo } from "./utils.js";
const { bar } = { bar: foo };  // destructured pattern (runtime, unresolvable)
bar(1);
foo(2);
foo(3);
foo(4);
