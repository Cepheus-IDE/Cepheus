---
name: refactor-large-function
description: Safely refactor a large function into small, well-named units with characterization tests guarding behaviour.
version: 1.0.0
category: Code quality
---
# Refactor a large function safely

Goal: the same observable behaviour, split into small, readable, testable pieces. Behaviour must not
change; tests prove it.

## Steps

1. **Understand it.** `read_file` the whole function and `search` for all its callers. Write down
   (in `update_plan`) its inputs, outputs, side effects (I/O, mutations, globals, exceptions) and
   the main phases it performs.
2. **Pin current behaviour with characterization tests** before changing anything:
   - Cover each major branch and the error paths with real inputs and the CURRENT outputs, even if
     they look odd (note suspicious behaviour for the user instead of "fixing" it).
   - Mock only external I/O. Run them: they must pass on the unchanged code.
   - If tests already cover it well (check with coverage), reuse them.
3. **Refactor in small, verified steps.** After EACH step run the tests (and type-check):
   1. Rename unclear local variables.
   2. Extract pure computations into functions with descriptive names (Extract Function).
   3. Replace nested conditionals with guard clauses / early returns.
   4. Split phases (parse, validate, compute, persist, format) into separate functions.
   5. Replace flag arguments with separate functions when a boolean switches behaviour.
   6. Replace long parameter lists with a parameter object when 4+ values travel together.
   7. Move duplicated blocks into one helper.
   8. Isolate side effects at the edges so the core is pure and easy to test.
4. **Keep the public signature** unless the user agreed to change it. If it must change, update
   every caller found in step 1.
5. **Do not mix** refactoring with feature changes or reformatting unrelated code.
6. Final pass: run the full test suite, linter and type-checker; compare the function's size and
   nesting depth before and after.

## Done when

- [ ] Characterization tests existed and passed before the first change.
- [ ] Tests passed after every step and at the end; no test expectations were changed.
- [ ] The original function reads as a short sequence of well-named steps.
- [ ] Public signature unchanged (or all callers updated with user agreement).
- [ ] Summary lists extracted functions and any suspicious behaviour found.
