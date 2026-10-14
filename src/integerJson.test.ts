import { expect, test } from "vitest";
import { parseIntegerJson } from "./integerJson.js";

test("preserves safe integers, nested arrays and numeric-looking strings", () => {
  const value = { max: 9007199254740991, min: -9007199254740991, zero: 0,
    nested: [true, null, { text: '1.0000000000000001 " 1e2 \\ 365.0', value: -42 }] };
  expect(parseIntegerJson(JSON.stringify(value))).toEqual(value);
});

test.each(["1.5", "1.0", "1e2", "1.0000000000000001", "9007199254740991.1",
  "9007199254740992", "-9007199254740992", "1e309"])("rejects raw non-integer or unsafe token %s", token => {
  expect(() => parseIntegerJson('{"nested":[' + token + "]}")).toThrow("safe whole integers");
});

test.each(['{"n":01}', '{"n":1,}', '{"n":NaN}'])("retains native JSON syntax rejection for %s", raw => {
  expect(() => parseIntegerJson(raw)).toThrow(SyntaxError);
});
