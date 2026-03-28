/**
 * Hash verification — run this to check SHA-256 matches command line.
 * Import from browser console or a test page.
 */
import { hashSeedSync } from "./hash.js";

export function runHashTests(): boolean {
  const tests = [
    // echo -n "hello_world:1" | sha256sum → 6f9fd973...
    { input: "hello_world:1", expected: 0x6f9fd973 },
    // echo -n "" | sha256sum → e3b0c442...
    { input: "", expected: 0xe3b0c442 },
    // echo -n "abc" | sha256sum → ba7816bf...
    { input: "abc", expected: 0xba7816bf },
    // echo -n "test" | sha256sum → 9f86d081...
    { input: "test", expected: 0x9f86d081 },
  ];

  let allPassed = true;
  for (const t of tests) {
    const got = hashSeedSync(t.input);
    const passed = got === t.expected;
    console.log(
      `SHA-256("${t.input}"): ` +
      `got 0x${got.toString(16).padStart(8, "0")}, ` +
      `expected 0x${t.expected.toString(16).padStart(8, "0")} ` +
      `${passed ? "✓" : "✗ FAIL"}`
    );
    if (!passed) allPassed = false;
  }
  return allPassed;
}
