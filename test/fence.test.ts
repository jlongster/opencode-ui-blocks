import { expect, test } from "bun:test"
import { UiFence } from "../src"

test.each([
  ["ui lua", { width: "auto", height: "auto" }],
  ["ui lua size=44x12", { width: 44, height: 12 }],
  ["ui lua size=auto x32", { width: "auto", height: 32 }],
  ["ui lua size=44 × 12", { width: 44, height: 12 }],
  ["ui lua size=50xauto", { width: 50, height: "auto" }],
  ["ui size=40x500", { width: 40, height: 60 }],
] as const)("%s", (info, expected) => {
  expect(UiFence.parseFence(info)).toMatchObject(expected)
})

test("other fences are not ui blocks", () => {
  expect(UiFence.parseFence("lua")).toBeUndefined()
  expect(UiFence.parseFence("uix")).toBeUndefined()
})
