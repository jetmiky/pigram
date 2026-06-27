import { describe, expect, test } from "bun:test";
import {
  type PairingState,
  type PairingDecision,
  decidePairing,
  applyPairing,
} from "../src/domain/pairing.ts";

describe("decidePairing", () => {
  test("unpaired state + first user → pair decision", () => {
    const state: PairingState = { pairedUserId: null };
    const decision = decidePairing(state, 12345);
    
    expect(decision).toEqual({ kind: "pair", userId: 12345 });
  });

  test("paired state + same user → accept decision", () => {
    const state: PairingState = { pairedUserId: 12345 };
    const decision = decidePairing(state, 12345);
    
    expect(decision).toEqual({ kind: "accept", userId: 12345 });
  });

  test("paired state + different user → reject decision", () => {
    const state: PairingState = { pairedUserId: 12345 };
    const decision = decidePairing(state, 67890);
    
    expect(decision).toEqual({ kind: "reject", userId: 67890 });
  });
});

describe("applyPairing", () => {
  test("apply pair decision → new state with pairedUserId set", () => {
    const originalState: PairingState = { pairedUserId: null };
    const decision: PairingDecision = { kind: "pair", userId: 12345 };
    
    const newState = applyPairing(originalState, decision);
    
    expect(newState.pairedUserId).toBe(12345);
    expect(originalState.pairedUserId).toBeNull(); // original not mutated
    expect(newState).not.toBe(originalState); // new object
  });

  test("apply accept decision → state unchanged", () => {
    const originalState: PairingState = { pairedUserId: 12345 };
    const decision: PairingDecision = { kind: "accept", userId: 12345 };
    
    const newState = applyPairing(originalState, decision);
    
    expect(newState.pairedUserId).toBe(12345);
    expect(originalState.pairedUserId).toBe(12345); // original unchanged
  });

  test("apply reject decision → state unchanged", () => {
    const originalState: PairingState = { pairedUserId: 12345 };
    const decision: PairingDecision = { kind: "reject", userId: 67890 };
    
    const newState = applyPairing(originalState, decision);
    
    expect(newState.pairedUserId).toBe(12345);
    expect(originalState.pairedUserId).toBe(12345); // original unchanged
  });

  test("applyPairing does not mutate input state", () => {
    const originalState: PairingState = { pairedUserId: null };
    const pairDecision: PairingDecision = { kind: "pair", userId: 12345 };
    
    applyPairing(originalState, pairDecision);
    
    expect(originalState.pairedUserId).toBeNull(); // still null after apply
  });
});
