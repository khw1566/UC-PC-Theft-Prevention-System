import assert from "node:assert/strict";
import { test } from "node:test";

import { compare } from "../src/compare.js";
import { outsideSchool, parseSchoolNetworks, primarySubnet } from "../src/net.js";
import { BASE, withComponents } from "./helpers.js";

test("unchanged has no findings", () => {
  assert.deepEqual(compare(BASE, BASE), []);
});

test("removed RAM is high", () => {
  const [f, ...rest] = compare(BASE, withComponents(BASE.components.filter((c) => c.key !== "RAMSN2")));
  assert.equal(rest.length, 0);
  assert.equal(f.severity, "high");
  assert.match(f.message, /RAMSN2/);
});

test("swapped disk reports removed and added", () => {
  const comps = [...BASE.components.filter((c) => c.kind !== "disk"), { kind: "disk", key: "OTHER", model: "Cheap" }];
  assert.deepEqual(compare(BASE, withComponents(comps)).map((f) => f.severity).sort(), ["high", "info"]);
});

test("same model without serial counts duplicates", () => {
  const gpu = { kind: "gpu", key: null, model: "NVIDIA GTX 1050" };
  const before = withComponents([gpu, gpu, gpu]);
  const [f] = compare(before, withComponents([gpu]));
  assert.equal(f.message, "사라짐: 그래픽카드 NVIDIA GTX 1050 ×2");
});

test("board change is high", () => {
  const [f] = compare(BASE, { ...BASE, board_serial: "XYZ" });
  assert.equal(f.severity, "high");
  assert.equal(f.message, "메인보드 일련번호 변경: BOARD123 → XYZ");
});

test("subnet change is medium", () => {
  const moved = { ...BASE, network: [{ ip: "10.1.9.5", mask: "255.255.255.0", gateway: "10.1.9.1" }] };
  const [f] = compare(BASE, moved);
  assert.equal(f.severity, "medium");
  assert.equal(f.message, "네트워크(호실) 변경: 10.1.3.0/24 → 10.1.9.0/24");
});

test("primary subnet prefers gateway and falls back to remote", () => {
  const report = { network: [
    { ip: "192.168.56.1", mask: "255.255.255.0" },
    { ip: "10.1.3.21", mask: "255.255.254.0", gateway: "10.1.2.1" },
  ] };
  assert.equal(primarySubnet(report), "10.1.2.0/23");
  assert.equal(primarySubnet({ network: [{ ip: "10.0.0.5", mask: "255.0.255.0" }] }), null); // 잘못된 마스크
  assert.equal(primarySubnet({}, "203.0.113.7"), "203.0.113.0/24");
  assert.equal(primarySubnet({}, "2001:db8::1"), null);
  assert.equal(primarySubnet({}, null), null);
});

test("outside school", () => {
  const nets = parseSchoolNetworks("203.0.113.0/24, 198.51.100.7,2001:db8:1::/48");
  assert.ok(!outsideSchool("203.0.113.50", nets));
  assert.ok(!outsideSchool("198.51.100.7", nets));
  assert.ok(!outsideSchool("2001:db8:1:ff::9", nets));
  assert.ok(outsideSchool("8.8.8.8", nets));
  assert.ok(outsideSchool("198.51.100.8", nets));
  assert.ok(outsideSchool("2001:db8:2::1", nets));
  // 대역 설정이 없거나 IP를 모르면 판단하지 않음
  assert.ok(!outsideSchool("8.8.8.8", []));
  assert.ok(!outsideSchool(null, nets));
  assert.ok(!outsideSchool("garbage", nets));
});
