import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Match from "../../tools/multiplayer/sim/match.js";
import * as Trig from "../../tools/multiplayer/sim/trig.js";
import { aiIntent, aiShop } from "../../tools/prototype/ai.js";
import { OPERATIONS, normalizeProfile, recordResult } from "../../tools/prototype/operations.js";

Trig.loadTrig(readFileSync(new URL("../../tables/trig.bin", import.meta.url)));

for (const operation of OPERATIONS) {
  test(`${operation.name}: five rounds, AI supply and a completed record`, () => {
    const specs = Array.from({ length: operation.players }, (_, index) => ({ name: `Test ${index}`, isAI: index > 0 }));
    const { state } = Match.createMatch(operation.seed, specs);
    let finishedRounds = 0;
    let shopVisits = 0;
    for (let guard = 0; guard < 1000 && !state.over; guard++) {
      if (state.phase === "shop") {
        for (const player of state.players) if (player.isAI) aiShop(player, operation.seed, state.roundNo);
        shopVisits++;
        Match.startNextRound(state);
        continue;
      }
      const actor = state.players[state.activeSlot];
      const intent = aiIntent(state.players, actor, state.wind, state.turnNo + 1, operation.seed, operation.level, state.roundTurn + 1);
      const result = Match.resolveMatchTurn(state, intent);
      assert.equal(result.settle.forced, false, `settlement turn ${state.turnNo}`);
      if (result.outcome.over) finishedRounds++;
    }
    assert.equal(state.over, true);
    assert.equal(state.phase, "done");
    assert.equal(finishedRounds, 5);
    assert.equal(shopVisits, 4);
    assert.ok(state.turnNo > operation.players);
    const profile = recordResult(normalizeProfile(null), operation.id, state.players);
    assert.equal(profile.operations[operation.id].completed, 1);
    assert.equal(profile.operations[operation.id].bestScore, state.players[0].score);
  });
}
