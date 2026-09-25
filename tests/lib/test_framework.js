/**
 * tests/lib/test_framework.js
 * Zero-Dependency BDD Test Framework Primitives (describe, it, expect)
 */

let currentSuite = null;
const rootSuites = [];

function describe(name, fn) {
  const suite = {
    name,
    parent: currentSuite,
    tests: [],
    beforeAllHooks: [],
    afterAllHooks: [],
    beforeEachHooks: [],
    afterEachHooks: [],
    suites: []
  };

  if (currentSuite) {
    currentSuite.suites.push(suite);
  } else {
    rootSuites.push(suite);
  }

  const prevSuite = currentSuite;
  currentSuite = suite;
  try {
    fn();
  } finally {
    currentSuite = prevSuite;
  }
}

function it(title, fn, timeoutMs = 5000) {
  if (!currentSuite) {
    throw new Error(`Test '${title}' must be defined inside a describe block.`);
  }
  currentSuite.tests.push({ title, fn, timeoutMs });
}

function beforeAll(fn) { if (currentSuite) currentSuite.beforeAllHooks.push(fn); }
function afterAll(fn) { if (currentSuite) currentSuite.afterAllHooks.push(fn); }
function beforeEach(fn) { if (currentSuite) currentSuite.beforeEachHooks.push(fn); }
function afterEach(fn) { if (currentSuite) currentSuite.afterEachHooks.push(fn); }

function expect(actual) {
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, but received ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) {
        throw new Error(`Expected deep equality:\n  Expected: ${b}\n  Actual:   ${a}`);
      }
    },
    toBeGreaterThan(expected) {
      if (!(actual > expected)) {
        throw new Error(`Expected ${actual} > ${expected}`);
      }
    },
    toBeLessThan(expected) {
      if (!(actual < expected)) {
        throw new Error(`Expected ${actual} < ${expected}`);
      }
    },
    toContain(item) {
      if (Array.isArray(actual) || typeof actual === 'string') {
        if (!actual.includes(item)) {
          throw new Error(`Expected collection to contain ${JSON.stringify(item)}`);
        }
      } else {
        throw new Error(`toContain requires array or string, received ${typeof actual}`);
      }
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy value, got ${actual}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy value, got ${actual}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${actual}`);
    }
  };
}

module.exports = {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  rootSuites
};
