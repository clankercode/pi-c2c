import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_TOPICS, renderC2cPiHelp } from "../src/help.ts";

test("renderC2cPiHelp: overview gives the core pi-c2c workflow", () => {
  const out = renderC2cPiHelp();
  assert.match(out, /c2c_pi_list/);
  assert.match(out, /c2c_pi_send/);
  assert.match(out, /Do not reply in plain text/i);
});

test("renderC2cPiHelp: reply topic includes exact DM and room call shapes", () => {
  const out = renderC2cPiHelp("reply");
  assert.match(out, /c2c_pi_send\(target="<sender>", body="<reply>"\)/);
  assert.match(out, /c2c_pi_send_room\(room="<room>", body="<reply>"\)/);
  assert.match(out, /plain assistant text is invisible/i);
});

test("renderC2cPiHelp: generic topic maps pi tools to generic c2c MCP and CLI names", () => {
  const out = renderC2cPiHelp("generic");
  assert.match(out, /c2c_send\(to_alias, content\)/);
  assert.match(out, /c2c_send_room\(room_id, content\)/);
  assert.match(out, /c2c send ALIAS MSG/);
  assert.match(out, /c2c rooms send ROOM MSG/);
});

test("renderC2cPiHelp: every public topic renders useful text", () => {
  for (const topic of HELP_TOPICS) {
    const out = renderC2cPiHelp(topic);
    assert.ok(out.includes(`c2c pi help: ${topic}`), topic);
    assert.ok(out.length > 80, topic);
  }
});
